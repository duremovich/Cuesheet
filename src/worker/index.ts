// Worker entry point. Durable Object classes must be exported from here.
import { app } from "./app";

export { ShowDO } from "./do/ShowDO";

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
