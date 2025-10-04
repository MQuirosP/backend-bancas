import pino from "pino";
import { config } from "../config";

const baseOptions: pino.LoggerOptions = {
  level: config.logLevel ?? "info",
};

const transport =
  config.nodeEnv !== "production"
    ? {
        target: "pino-pretty",
        options: {
          singleLine: true,
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      }
    : undefined;

const logger = pino({ ...baseOptions, transport } as any);

export default logger;
