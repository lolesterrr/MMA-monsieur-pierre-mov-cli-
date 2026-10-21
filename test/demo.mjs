// Offline demo: the fake sources plus the local helper wired to them.
//   node test/demo.mjs        then open http://127.0.0.1:8787
// Everything is made up (titles, posters, the stream), so it works with no internet at all.
import { startFake } from "./fake-sources.mjs";
import { startLocal } from "../local/server.mjs";

const port = Number(process.env.PORT) || 8787;
const fake = await startFake();
const app = await startLocal({
  port,
  catalog: fake.host.catalog,
  env: {
    ...fake.env,
    GITHUB_TOKEN: process.env.DEMO_NO_TOKEN ? "" : "test-github-token",
    COMPLAINTS_PER_10_MIN: "1000",
    HEALTH_TITLE: "tt0000101,9101,The Grand Budapest Nap,2014",
  },
});
console.log(`MMA demo on ${app.url} (fake catalog at ${fake.host.catalog})`);
process.on("SIGINT", async () => {
  await app.close();
  await fake.stop();
  process.exit(0);
});
