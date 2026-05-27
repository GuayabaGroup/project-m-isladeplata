import { type Logger, createLogger, format, transports } from 'winston';
import { env, isProduction } from '../../config/env.js';

const baseFormat = isProduction
  ? format.combine(format.timestamp(), format.errors({ stack: true }), format.json())
  : format.combine(
      format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      format.errors({ stack: true }),
      format.colorize(),
      format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} [${level}] ${message}${metaStr}`;
      }),
    );

export const logger: Logger = createLogger({
  level: env.LOG_LEVEL === 'silent' ? 'error' : env.LOG_LEVEL,
  silent: env.LOG_LEVEL === 'silent',
  format: baseFormat,
  transports: [new transports.Console()],
});
