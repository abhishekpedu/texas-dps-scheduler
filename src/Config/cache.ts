import fs from "node:fs";
import dayjs from "dayjs";
import dayjsDuration from "dayjs/plugin/duration";
import { z } from "zod";
import parseConfig from "../Config";
import * as log from "../Log";

dayjs.extend(dayjsDuration);

const config = parseConfig();

const CACHE_PATH = "././cache/auth.json";
const CACHE_MAX_AGE_MINUTES = 10;

const cacheSchema = z.object({
	timestamp: z.number(),
	authToken: z.string(),
	responseId: z.number(),
	authUserName: z.string(),
});

type cacheSchemaType = z.infer<typeof cacheSchema>;

export const writeCache = (data: cacheSchemaType) => {
	const cacheData = cacheSchema.parse(data);
	fs.writeFileSync(CACHE_PATH, JSON.stringify(cacheData, null, 2));
};

export const readCache = (): cacheSchemaType | null => {
	try {
		if (!fs.existsSync(CACHE_PATH)) return null;
		const data = cacheSchema.parse(
			JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8")),
		);

		if (
			dayjs.duration(dayjs().diff(dayjs(data.timestamp))).asMinutes() >
			CACHE_MAX_AGE_MINUTES
		) {
			log.info("Cache expired, need to get new auth token");
			return null;
		}

		// The cached token belongs to whoever was configured when it was written.
		if (data.authUserName !== config.personalInfo.authUserName) {
			log.info("Cache belongs to a different user, need to get new auth token");
			return null;
		}

		return data;
	} catch (err) {
		log.error("Error while reading cache: ", err as Error);
		return null;
	}
};
