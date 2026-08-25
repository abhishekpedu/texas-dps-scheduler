import { createServer } from "node:http";
import https from "node:https";
import sleep from "node:timers/promises";
import axios, { type AxiosResponse } from "axios";
import dayjs from "dayjs";
import isBetween from "dayjs/plugin/isBetween";
import { getAuthTokenFromBrowser } from "../Browser";
import {
	CreateCaptchaSolverTask,
	GetCaptchaSolverResult,
} from "../CaptchaSolver";
import parseConfig from "../Config";
import * as log from "../Log";

dayjs.extend(isBetween);

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import PQueue from "p-queue";
import prompts from "prompts";
import { readCache, writeCache } from "../Config/cache";
import type { AuthPayload } from "../Interfaces/Auth";
import type {
	AvailableLocationPayload,
	AvailableLocationResponse,
} from "../Interfaces/AvailableLocation";
import type {
	AvailableLocationDatesPayload,
	AvailableLocationDatesResponse,
	AvailableTimeSlots,
} from "../Interfaces/AvailableLocationDates";
import type { BookSlotPayload, BookSlotResponse } from "../Interfaces/BookSlot";
import type { CancelBookingPayload } from "../Interfaces/CancelBooking";
import type {
	ExistBookingPayload,
	ExistBookingResponse,
} from "../Interfaces/ExistBooking";
import type { HoldSlotPayload, HoldSlotResponse } from "../Interfaces/HoldSlot";
import { pushNotification } from "../PushNotification";

let packagejson: { version: string | null } = { version: null };
try {
	packagejson = require("../../package.json");
} catch {
	try {
		packagejson = require("../package.json");
	} catch {
		packagejson = { version: null };
	}
}

interface CaptchaResult {
	captchaToken: string;
	userAgent: string;
}

class TexasScheduler {
	private readonly requestClient = axios.create({
		baseURL: "https://apptapi.txdpsscheduler.com",
		httpsAgent: new https.Agent({ rejectUnauthorized: false }),
	});
	public config = parseConfig();
	public existBooking: ExistBookingResponse[] = [];

	private availableLocation: AvailableLocationResponse[] | null = null;
	private isBooked = false;
	private isHeld = false;
	private readonly queue = new PQueue({ concurrency: 1 });
	private authToken = "";
	private readonly maxCaptchaSolverRetries = 25;
	private responseId: number | null = null;
	private userAgent: string | null = null;

	public constructor() {
		log.info(`Texas Scheduler v${packagejson.version} is starting...`);
		if (!existsSync("cache")) mkdirSync("cache");
	}

	public async run() {
		if (this.config.appSettings.webserver)
			createServer((_req, res) => res.end("Bot is alive!")).listen(
				process.env.PORT || 3000,
			);
		await this.authenticate();

		if (this.existBooking.length > 0) {
			log.warn(`You have: ${this.existBooking.length} existing booking(s)`);
			for (const booking of this.existBooking) {
				log.warn(
					`Booking at ${booking.SiteName} ${dayjs(booking.BookingDateTime).format("MM/DD/YYYY hh:mm A")} for ${booking.ServiceType}`,
				);
			}
			if (!this.config.appSettings.cancelIfExist) {
				log.warn(
					"The bot will continue to run, but WILL NOT cancel existing booking if it found a new one",
				);
			}
		}
		log.info("Requesting Available Location....");
		await this.requestAvailableLocation();
		await this.getLocationDatesAll();
	}

	public async runCancel() {
		await this.authenticate();

		if (this.existBooking.length === 0) {
			log.info("You have no existing booking to cancel");
			return;
		}

		const { bookings } = await prompts({
			type: "multiselect",
			name: "bookings",
			message: "Choose the booking(s) you want to cancel",
			choices: this.existBooking.map((booking) => ({
				title: `${booking.SiteName} - ${dayjs(booking.BookingDateTime).format("MM/DD/YYYY hh:mm A")} - ${booking.ServiceType} (${booking.ConfirmationNumber})`,
				value: booking,
			})),
			onState: (state: { aborted: boolean }) =>
				state.aborted ? process.exit(1) : null,
		});

		if (!bookings || bookings.length === 0) {
			log.info("No booking selected, nothing was canceled");
			return;
		}

		const { confirmed } = await prompts({
			type: "confirm",
			name: "confirmed",
			message: `Cancel ${bookings.length} booking(s)? This cannot be undone.`,
			initial: false,
			onState: (state: { aborted: boolean }) =>
				state.aborted ? process.exit(1) : null,
		});

		if (!confirmed) {
			log.info("Canceled by user, nothing was canceled");
			return;
		}

		for (const booking of bookings as ExistBookingResponse[]) {
			log.info(
				`Canceling booking at ${booking.SiteName} ${dayjs(booking.BookingDateTime).format("MM/DD/YYYY hh:mm A")}...`,
			);
			await this.cancelBooking(booking.ConfirmationNumber);
		}
	}

	/** Restores the session from cache when possible, otherwise logs in from scratch. */
	private async authenticate() {
		const cache = readCache();
		if (cache) {
			this.authToken = cache.authToken;
			this.responseId = cache.responseId;
			log.info("Auth token and responseId loaded from cache");
			// The cache holds no bookings, so they have to be fetched separately.
			await this.checkExistBooking();
			return;
		}
		await this.getAuthToken();
	}

	private async checkExistBooking() {
		const requestBody: ExistBookingPayload = {
			FirstName: this.config.personalInfo.firstName,
			LastName: this.config.personalInfo.lastName,
			DateOfBirth: this.config.personalInfo.dob,
			LastFourDigitsSsn: this.config.personalInfo.lastFourSSN,
		};

		this.existBooking = await this.requestApi(
			"/api/Booking",
			"POST",
			requestBody,
		).then((res) => res.data);
	}

	private async cancelBooking(ConfirmationNumber: string) {
		const requestBody: CancelBookingPayload = {
			ConfirmationNumber,
			DateOfBirth: this.config.personalInfo.dob,
			LastFourDigitsSsn: this.config.personalInfo.lastFourSSN,
			FirstName: this.config.personalInfo.firstName,
			LastName: this.config.personalInfo.lastName,
		};
		await this.requestApi("/api/CancelBooking", "POST", requestBody);
		log.info("Canceled booking successfully");
	}

	public async getAllLocation(): Promise<AvailableLocationResponse[]> {
		const zipcodeList = this.config.location.zipCode;
		const cityNameList = this.config.location.cityName;
		const typeId = this.config.personalInfo.typeId || 71;

		const finalArray: AvailableLocationResponse[] = [];
		if (cityNameList.length > 0 && cityNameList[0] !== "") {
			for (const cityName of cityNameList) {
				const response = await this.getLocationForCity(cityName, typeId);
				finalArray.push(...response);
			}
		} else {
			for (const zipCode of zipcodeList) {
				const response = await this.getLocationForZipCode(zipCode, typeId);
				finalArray.push(...response);
			}
		}
		return this.filterAndSortLocations(finalArray);
	}

	private async getLocationForCity(
		cityName: string,
		typeId: number,
	): Promise<AvailableLocationResponse[]> {
		const requestBody: AvailableLocationPayload = {
			CityName: cityName,
			PreferredDay: 0,
			TypeId: typeId,
			ZipCode: "",
		};

		const response = await this.fetchLocationData(requestBody);
		if (response === null) {
			log.warn(`No location found for city: ${cityName}`);
			sleep.setTimeout(2000);
			return [];
		}

		if (response.length !== 0) {
			log.info(`Found ${response.length} locations for City: ${cityName}`);
		}
		for (const el of response) el.CityName = cityName;
		return response;
	}

	private async getLocationForZipCode(
		zipCode: string,
		typeId: number,
	): Promise<AvailableLocationResponse[]> {
		const requestBody: AvailableLocationPayload = {
			CityName: "",
			PreferredDay: 0,
			TypeId: typeId,
			ZipCode: zipCode,
		};

		const response = await this.fetchLocationData(requestBody);
		if (response === null) {
			log.warn(`No location found for zipcode: ${zipCode}`);
			sleep.setTimeout(2000);
			return [];
		}

		if (response.length !== 0) {
			log.info(`Found ${response.length} locations for zipcode: ${zipCode}`);
		}
		for (const el of response) el.ZipCode = zipCode;
		return response;
	}

	private async fetchLocationData(
		requestBody: AvailableLocationPayload,
	): Promise<AvailableLocationResponse[]> {
		return await this.requestApi(
			"/api/AvailableLocation/",
			"POST",
			requestBody,
		).then((res) => res.data as AvailableLocationResponse[]);
	}

	private filterAndSortLocations(
		locations: AvailableLocationResponse[],
	): AvailableLocationResponse[] {
		return locations
			.sort((a, b) => a.Distance - b.Distance)
			.filter(
				(elem, index, self) =>
					self.findIndex((obj) => obj.Id === elem.Id) === index,
			);
	}
	private isAvailableDateMatchMyDates(availableBookinDate: string) {
		const myDates = this.config.location.specificDates;
		// Check if empty array OR array with only empty strings
		if (!myDates?.length || myDates.every((date) => !date.trim())) return true;

		const availableDate = dayjs(availableBookinDate);
		const matchedDate = myDates.find((date) => {
			if (!date.trim()) return false;
			const preferredDate = dayjs(date, "MM/DD/YYYY");
			return availableDate.isSame(preferredDate, "day");
		});

		if (matchedDate) {
			console.log(
				`Available date ${availableBookinDate} matches with preferred date ${matchedDate}`,
			);
		}
		return !!matchedDate;
	}
	public async requestAvailableLocation(): Promise<void> {
		const response = await this.getAllLocation();
		if (response.length === 0) {
			log.error(
				"No Available location found! You can try add more zipcodes or set city name!",
			);
			process.exit(0);
		}
		if (this.config.location.pickDPSLocation) {
			if (existsSync("././cache/location.json")) {
				this.availableLocation = JSON.parse(
					readFileSync("././cache/location.json", "utf-8"),
				);
				log.info(
					"Found cached location selection, using cached location selection",
				);
				log.info(
					"If you want to change location selection, please delete cache folder!",
				);
				return;
			}
			const userResponse = await prompts({
				type: "multiselect",
				name: "location",
				message: "Choose DPS location, you can choose multiple locations!",
				choices: response.map((el) => ({
					title: `${el.Name} - ${el.Address} - ${el.Distance} miles away from ${el.ZipCode ? el.ZipCode : el.CityName}!`,
					value: el,
				})),
				onState: (state: { aborted: boolean }) =>
					state.aborted ? process.exit(1) : null,
			});
			if (!userResponse.location || userResponse.location.length === 0) {
				log.error("You must choose at least one location!");
				process.exit(1);
			}
			this.availableLocation = userResponse.location;
			writeFileSync(
				"././cache/location.json",
				JSON.stringify(userResponse.location),
			);
			return;
		}
		const filteredResponse = response.filter(
			(location: AvailableLocationResponse) =>
				location.Distance < this.config.location.miles,
		);
		if (filteredResponse.length === 0) {
			log.error(
				`No Available location found! Nearest location is ${response[0].Distance} miles away! Please change your config and try again!`,
			);
			process.exit(0);
		}
		log.info(
			`Found ${filteredResponse.length} Available location that match your criteria`,
		);
		log.info(`${filteredResponse.map((el) => el.Name).join(", ")}`);
		this.availableLocation = filteredResponse;
		return;
	}

	private async getLocationDatesAll() {
		log.info("Checking Available Location Dates....");
		if (!this.availableLocation) return;
		const getLocationFunctions = this.availableLocation.map(
			(location) => () =>
				sleep.setTimeout(5000).then(() => this.getLocationDates(location)),
		);
		for (;;) {
			console.log(
				"--------------------------------------------------------------------------------",
			);
			await this.queue.addAll(getLocationFunctions).catch(() => null);
			await sleep.setTimeout(this.config.appSettings.interval);
		}
	}

	private async getLocationDates(location: AvailableLocationResponse) {
		const locationConfig = this.config.location;
		const requestBody: AvailableLocationDatesPayload = {
			LocationId: location.Id,
			PreferredDay: 0,
			SameDay: locationConfig.sameDay,
			StartDate: null,
			TypeId: this.config.personalInfo.typeId || 71,
		};
		const response = (await this.requestApi(
			"/api/AvailableLocationDates",
			"POST",
			requestBody,
		).then((res) => res.data)) as AvailableLocationDatesResponse;
		let AvailableDates = response.LocationAvailabilityDates;

		if (!locationConfig.sameDay) {
			AvailableDates = response.LocationAvailabilityDates.filter((date) => {
				const AvailabilityDate = dayjs(date.AvailabilityDate);
				const startDate = dayjs(this.config.location.daysAround.startDate);
				let preferredDaysCondition = true;
				if (locationConfig.preferredDays.length > 0)
					preferredDaysCondition = locationConfig.preferredDays.includes(
						AvailabilityDate.day(),
					);
				return (
					AvailabilityDate.isBetween(
						startDate.add(locationConfig.daysAround.start, "day"),
						startDate.add(locationConfig.daysAround.end, "day"),
						"day",
					) &&
					date.AvailableTimeSlots.length > 0 &&
					preferredDaysCondition
				);
			});
		}

		if (AvailableDates.length !== 0) {
			const filteredAvailabilityDates = AvailableDates.map((date) => {
				const filteredTimeSlots = date.AvailableTimeSlots.filter((timeSlot) => {
					const startDateTime = dayjs(timeSlot.StartDateTime);
					const startHour = startDateTime.hour();
					return (
						startHour >= this.config.location.timesAround.start &&
						startHour < this.config.location.timesAround.end
					);
				});
				return {
					...date,
					AvailableTimeSlots: filteredTimeSlots,
				};
			}).filter((date) => date.AvailableTimeSlots.length > 0);

			const booking = filteredAvailabilityDates[0].AvailableTimeSlots[0];

			log.info(
				`${location.Name} is Available on ${booking.FormattedStartDateTime}`,
			);

			const matchSpecificDates = this.isAvailableDateMatchMyDates(
				booking.FormattedStartDateTime,
			);
			if (!matchSpecificDates) return;
			if (!this.queue.isPaused) this.queue.pause();
			if (
				!this.config.appSettings.cancelIfExist &&
				this.existBooking.length > 0
			) {
				log.warn(
					"cancelIfExist is disabled! Please cancel existing appointment manually!",
				);
				process.exit(0);
			}
			this.holdSlot(booking, location);
			return Promise.resolve(true);
		}
		log.info(
			`${location.Name} is not Available in ${
				locationConfig.sameDay
					? "the same day"
					: `around ${locationConfig.daysAround.start}-${locationConfig.daysAround.end} days from ${this.config.location.daysAround.startDate}!`
			} `,
		);

		return Promise.reject();
	}

	private async requestApi(
		path: string,
		method: "GET" | "POST",
		body: object,
		retryTime = 0,
	): Promise<AxiosResponse> {
		const headers = {
			"Content-Type": "application/json;charset=UTF-8",
			Origin: "https://www.txdpsscheduler.com",
			Referer: "https://www.txdpsscheduler.com",
			Dnt: "1",
		};
		if (this.authToken) headers.Authorization = this.authToken;
		if (this.userAgent) headers["User-Agent"] = this.userAgent;

		const response = await this.requestClient.request({
			method,
			url: path,
			headers,
			timeout: this.config.appSettings.headersTimeout,
			data: method === "POST" ? body : undefined, // Include body only for POST requests
			validateStatus: () => true,
		});

		if (response.status !== 200) {
			log.warn(`Got ${response.status} status code`);
			log.info(`Endpoint: ${path}`);
			log.dev(`Auth token: ${headers.Authorization}`);
			if (response.status === 401) {
				log.info("Auth token expired! Try to get new token...");
				await this.getAuthToken();
			}
			if (response.status === 403) {
				log.warn("Got rate limited, sleep for 10s...");
				await sleep.setTimeout(10000);
				return this.requestApi(path, method, body, retryTime + 1);
			}
			if (retryTime < this.config.appSettings.maxRetry) {
				log.info(
					`Retrying failed request... (Retry ${retryTime + 1}/${this.config.appSettings.maxRetry})`,
				);
				return this.requestApi(path, method, body, retryTime + 1);
			}
			log.error(`Got ${response.status} status code, retrying failed!`);
			process.exit(1);
		}
		return response;
	}

	private async holdSlot(
		booking: AvailableTimeSlots,
		location: AvailableLocationResponse,
	) {
		if (this.isHeld) return;
		const requestBody: HoldSlotPayload = {
			DateOfBirth: this.config.personalInfo.dob,
			FirstName: this.config.personalInfo.firstName,
			LastName: this.config.personalInfo.lastName,
			Last4Ssn: this.config.personalInfo.lastFourSSN,
			SlotId: booking.SlotId,
		};
		const response = (await this.requestApi(
			"/api/HoldSlot",
			"POST",
			requestBody,
		).then((res) => res.data)) as HoldSlotResponse;
		if (response.SlotHeldSuccessfully !== true) {
			log.error(`Failed to hold slot: ${response.ErrorMessage}`);
			if (this.queue.isPaused) this.queue.start();
			return;
		}
		log.info("Slot hold successfully. Sleeping for 5s...");
		this.isHeld = true;
		await sleep.setTimeout(5000);
		await this.bookSlot(booking, location);
	}

	private async bookSlot(
		booking: AvailableTimeSlots,
		location: AvailableLocationResponse,
	) {
		if (this.isBooked) return;
		log.info("Booking slot....");
		if (this.existBooking.length > 0) {
			log.info(
				`Canceling existing booking ${this.existBooking[0].ConfirmationNumber}`,
			);
			await this.cancelBooking(this.existBooking[0].ConfirmationNumber);
		}
		const requestBody: BookSlotPayload = {
			AdaRequired: false,
			BookingDateTime: booking.StartDateTime,
			BookingDuration: booking.Duration,
			CardNumber: "",
			CellPhone: this.config.personalInfo.phoneNumber
				? this.config.personalInfo.phoneNumber
				: "",
			DateOfBirth: this.config.personalInfo.dob,
			Email: this.config.personalInfo.email,
			FirstName: this.config.personalInfo.firstName,
			LastName: this.config.personalInfo.lastName,
			HomePhone: "",
			Last4Ssn: this.config.personalInfo.lastFourSSN,
			ResponseId: this.responseId,
			SendSms: !!this.config.personalInfo.phoneNumber,
			ServiceTypeId: this.config.personalInfo.typeId || 71,
			SiteId: location.Id,
			SpanishLanguage: "N",
		};

		const response = await this.requestApi(
			"/api/NewBooking",
			"POST",
			requestBody,
		);
		if (response.status === 200) {
			const bookingInfo = response.data as BookSlotResponse;
			if (bookingInfo?.Booking === null) {
				if (this.queue.isPaused) this.queue.start();
				log.error("Failed to book slot");
				log.error(JSON.stringify(bookingInfo));
				this.isHeld = false;
				return;
			}
			const appointmentURL = `https://www.txdpsscheduler.com/?b=${bookingInfo.Booking.ConfirmationNumber}`;
			this.isBooked = true;
			log.info(
				`Slot booked successfully. Confirmation Number: ${bookingInfo.Booking.ConfirmationNumber}`,
			);
			log.info(`Visiting this link to print your booking:`);
			log.info(appointmentURL);
			if (this.config.appSettings.pushNotification.enabled) {
				log.info("Sending notification...");
				await pushNotification(
					`Booked for ${this.config.personalInfo.firstName} ${this.config.personalInfo.lastName}. URL: ${appointmentURL}`,
				).catch((error) => {
					log.error("Failed to send notification", error);
				});
			}
			process.exit(0);
		} else {
			if (this.queue.isPaused) this.queue.start();
			log.error("Failed to book slot");
			log.error(response.data);
		}
	}

	private async getAuthToken() {
		if (this.config.appSettings.captcha.strategy === "solver") {
			const captchaToken = await this.getCaptchaToken();
			const requestBody: AuthPayload = {
				UserName: this.config.personalInfo.authUserName,
				RecaptchaToken: {
					Action: "login",
					Token: captchaToken,
				},
				CellPhone: "",
				Email: this.config.personalInfo.email,
				IsEmail: true,
				IsMobile: false,
				UserDetails: {
					CardNumber: "",
					DateOfBirth: this.config.personalInfo.dob,
					FirstName: this.config.personalInfo.firstName,
					LastName: this.config.personalInfo.lastName,
					LastFourDigitsSsn: this.config.personalInfo.lastFourSSN,
				},
			};

			log.dev(`Captcha token: ${captchaToken}`);
			log.dev(`Request body: ${JSON.stringify(requestBody)}`);
			const response = await this.requestApi(
				"/api/v1/account/auth",
				"POST",
				requestBody,
			);
			this.authToken = response.data.data.token;
			const elibigleCard = JSON.parse(response.data.data.eligibleCards);
			this.responseId = elibigleCard[0].ResponseId;
			this.existBooking = JSON.parse(response.data.data.existingBookings);
		} else if (this.config.appSettings.captcha.strategy === "browser") {
			const { token, responseId } = await getAuthTokenFromBrowser();
			this.authToken = token;
			this.responseId = responseId;
			// Unlike the solver flow, the browser flow returns no bookings.
			await this.checkExistBooking();
		}

		if (this.authToken && this.responseId) {
			writeCache({
				authToken: this.authToken,
				responseId: this.responseId,
				timestamp: dayjs().valueOf(),
				authUserName: this.config.personalInfo.authUserName,
			});
		}
	}

	private async getCaptchaToken(
		taskId?: string | null,
		retries = 0,
	): Promise<string> {
		if (retries > this.maxCaptchaSolverRetries) {
			log.error(
				`Get captcha token failed after ${this.maxCaptchaSolverRetries} retries! will retry!`,
			);
			return await this.getCaptchaToken(null, 0);
		}
		if (!taskId) taskId = await CreateCaptchaSolverTask();
		const captchaResult = await this.getCaptchaResult(taskId);
		if (captchaResult === undefined) {
			await sleep.setTimeout(2000);
			return this.getCaptchaToken(taskId, retries + 1);
		}
		if (captchaResult === null) {
			log.error(
				"get captcha token failed! will create new task and sleep 10s!",
			);
			await sleep.setTimeout(10000);
			return this.getCaptchaToken(null, retries + 1);
		}
		log.info("Captcha token received successfully");
		this.userAgent = captchaResult.userAgent;
		return captchaResult.captchaToken;
	}

	private async getCaptchaResult(
		taskId: string | null,
	): Promise<CaptchaResult | undefined | null> {
		if (!taskId) return null;
		log.info(`Waiting for captcha token from task ${taskId}...`);
		try {
			const captchaResult = await GetCaptchaSolverResult(taskId);
			if (captchaResult.status !== "ready") {
				if (captchaResult.status === "processing") return undefined;
				else return null;
			}
			return {
				captchaToken: captchaResult.solution.gRecaptchaResponse,
				userAgent: captchaResult.solution.userAgent,
			};
		} catch (err) {
			log.error("Error while getting captcha token: ", err as Error);
			return null;
		}
	}
}

export default TexasScheduler;
