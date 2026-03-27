import pino from "pino";
import type { DestinationStream, Logger as PinoLogger } from "pino";
import type { RunEvent } from "@reddwarf/contracts";

export interface PlanningPipelineLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child?(bindings: Record<string, unknown>): PlanningPipelineLogger;
}

export interface PlanningLogRecord {
  level: RunEvent["level"];
  message: string;
  bindings: Record<string, unknown>;
}

export interface PinoPlanningLoggerOptions {
  level?: RunEvent["level"];
  baseBindings?: Record<string, unknown>;
  destination?: DestinationStream;
}

export interface BufferedPlanningLogger {
  logger: PlanningPipelineLogger;
  records: PlanningLogRecord[];
}

export function createNoopLogger(): PlanningPipelineLogger {
  return {
    info() {},
    warn() {},
    error() {},
    child() {
      return createNoopLogger();
    }
  };
}

export const defaultLogger: PlanningPipelineLogger = createNoopLogger();

function wrapPinoLogger(logger: PinoLogger): PlanningPipelineLogger {
  return {
    info(message, context) {
      logger.info(context ?? {}, message);
    },
    warn(message, context) {
      logger.warn(context ?? {}, message);
    },
    error(message, context) {
      logger.error(context ?? {}, message);
    },
    child(bindings) {
      return wrapPinoLogger(logger.child(bindings));
    }
  };
}

export function bindPlanningLogger(
  logger: PlanningPipelineLogger,
  bindings: Record<string, unknown>
): PlanningPipelineLogger {
  if (logger.child) {
    return logger.child(bindings);
  }

  return {
    info(message, context) {
      logger.info(message, {
        ...bindings,
        ...(context ?? {})
      });
    },
    warn(message, context) {
      logger.warn(message, {
        ...bindings,
        ...(context ?? {})
      });
    },
    error(message, context) {
      logger.error(message, {
        ...bindings,
        ...(context ?? {})
      });
    },
    child(childBindings) {
      return bindPlanningLogger(logger, {
        ...bindings,
        ...childBindings
      });
    }
  };
}

export function createPinoPlanningLogger(
  options: PinoPlanningLoggerOptions = {}
): PlanningPipelineLogger {
  const logger = pino(
    {
      name: "reddwarf.control-plane",
      level:
        options.level ??
        (process.env.REDDWARF_LOG_LEVEL as RunEvent["level"] | undefined) ??
        "info",
      base: {
        service: "reddwarf-control-plane",
        ...(options.baseBindings ?? {})
      }
    },
    options.destination
  );

  return wrapPinoLogger(logger);
}

export function createBufferedPlanningLogger(): BufferedPlanningLogger {
  const records: PlanningLogRecord[] = [];

  const createLogger = (
    bindings: Record<string, unknown>
  ): PlanningPipelineLogger => ({
    info(message, context) {
      records.push({
        level: "info",
        message,
        bindings: {
          ...bindings,
          ...(context ?? {})
        }
      });
    },
    warn(message, context) {
      records.push({
        level: "warn",
        message,
        bindings: {
          ...bindings,
          ...(context ?? {})
        }
      });
    },
    error(message, context) {
      records.push({
        level: "error",
        message,
        bindings: {
          ...bindings,
          ...(context ?? {})
        }
      });
    },
    child(childBindings) {
      return createLogger({
        ...bindings,
        ...childBindings
      });
    }
  });

  return {
    logger: createLogger({}),
    records
  };
}
