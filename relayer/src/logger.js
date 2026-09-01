// Structured JSON logger for the relayer.
// Each log line is one JSON object — easy to parse with any log aggregator
// (Datadog, Grafana Loki, CloudWatch, etc.). In development, logs are
// pretty-printed for readability instead.

const isPretty = process.env.NODE_ENV !== "production";

function log(level, event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };

  if (isPretty) {
    const prefix = {
      info:  "\x1b[36mINFO \x1b[0m",
      warn:  "\x1b[33mWARN \x1b[0m",
      error: "\x1b[31mERROR\x1b[0m",
    }[level] || level;
    const details = Object.keys(data).length ? " " + JSON.stringify(data) : "";
    console.log(`${prefix} [${entry.ts}] ${event}${details}`);
  } else {
    console.log(JSON.stringify(entry));
  }
}

const logger = {
  info:  (event, data) => log("info",  event, data),
  warn:  (event, data) => log("warn",  event, data),
  error: (event, data) => log("error", event, data),
};

module.exports = logger;
