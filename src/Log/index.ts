import { green, red, yellow } from "colorette";

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("America/Chicago");

const timeNow = () => dayjs().format("MM/DD/YYYY h:mm:ss");

const msg = (func: (text: string) => void, message: string) =>
	func(`${yellow(`[${timeNow()}]`)} ${green(message)}`);

const error = (message = "Unknown error", err?: Error) => {
	console.error(`[${yellow(timeNow())}] ERROR: ${red(message)}`);
	if (err) console.error(err);
};

const info = (message: string) => msg(console.info, message);

// Development mode logging
const dev = (message: string) =>
	process.env.NODE_ENV === "development"
		? msg(console.info, `${yellow("DEBUG ->")} ${message}`)
		: null;

const warn = (message: string) =>
	msg(console.warn, `${yellow("WARNING ->")} ${message}`);

export { dev, error, info, warn };
