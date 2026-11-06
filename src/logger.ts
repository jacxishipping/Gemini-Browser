const LEVEL_WEIGHTS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
} as const;

type LogLevel = keyof typeof LEVEL_WEIGHTS;

const configuredLevel = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const threshold =
  LEVEL_WEIGHTS[configuredLevel as LogLevel] ?? LEVEL_WEIGHTS.info;

type LogMeta = Record<string, unknown>;

function stringify(payload: LogMeta): string {
  return JSON.stringify(payload, (_key, value: unknown) => {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack
      };
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  });
}

function emit(level: Exclude<LogLevel, 'silent'>, message: string, meta?: LogMeta): void {
  if (LEVEL_WEIGHTS[level] < threshold) {
    return;
  }

  const payload: LogMeta = {
    time: new Date().toISOString(),
    level,
    message
  };
  if (meta) {
    Object.assign(payload, meta);
  }

  let line: string;
  try {
    line = stringify(payload);
  } catch {
    line = JSON.stringify({
      time: payload.time,
      level,
      message,
      meta: '[unserializable]'
    });
  }

  // stdout is reserved for the MCP protocol when using stdio transport.
  process.stderr.write(`${line}\n`);
}

export const logger = {
  debug(message: string, meta?: LogMeta): void {
    emit('debug', message, meta);
  },
  info(message: string, meta?: LogMeta): void {
    emit('info', message, meta);
  },
  warn(message: string, meta?: LogMeta): void {
    emit('warn', message, meta);
  },
  error(message: string, meta?: LogMeta): void {
    emit('error', message, meta);
  }
};
