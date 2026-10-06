// Watchdog for the Clock DO (src/clock.js): the single hourly Cron Trigger
// asks the clock to verify its alarm chain. If the alarm is missing or
// stuck in the past, the clock fires anything due and re-arms itself.
// Dispatch + record core lives in the Clock; this only knocks on its door.

export async function handleClockWatchdog(env) {
  if (!env.CLOCK || typeof env.CLOCK.getByName !== "function") {
    console.error("[cron] CLOCK binding missing - clock not deployed?");
    return { ok: false, reason: "CLOCK binding missing" };
  }
  try {
    const stub = env.CLOCK.getByName("clock");
    const res = await stub.fetch("https://clock/ensure");
    let body = {};
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    console.log(`[cron] clock ensure: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    console.error(`[cron] clock unreachable: ${(e && e.message) || e}`);
    return { ok: false, reason: String((e && e.message) || e).slice(0, 200) };
  }
}
