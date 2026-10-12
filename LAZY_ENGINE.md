# Managed engine lifecycle

The managed Dani Free engine starts only when a routed model request needs it. Startup, `/health`, `/v1/models`, catalog refresh and recovery do not start it or run managed inference. Discovery reads the public models.dev registry, with a 10-second deadline and 16 MiB cap. It admits only text models with explicit finite zero tariffs and positive finite limits. Registry metadata is not proof of live inference availability. The authenticated health response reports this distinction.

Requests acquire engine leases before creating a session and release them after session cleanup. The engine sleeps 60 seconds after the last lease is released. Concurrent callers share startup. Cancellation of one caller cannot cancel another caller's startup. Teardown waits for exit, escalates after 2 seconds, and blocks restart if exit is unconfirmed after 5 seconds. Crashed engines restart on the next real request, not in the background.

Caller-owned external sidecars keep their existing discovery and probe behavior. With a managed engine, refresh-time probing is disabled for the whole router, including Kilo. Recovery skips only the managed adapter. Daily automatic engine updates/restarts are no longer performed behind active sessions. Existing seed verification, local key guard, single Dani Free Auto public model and keyless upstream routing remain unchanged.

Offline cached catalog retention still follows existing catalog behavior on registry failure. Fresh installs can be degraded if registry discovery fails. A metadata-eligible route can still fail at first use; existing router failure/fallback handling applies. No claim is made here about provider uptime, whole-desktop RAM usage or native Mac/Windows performance.
