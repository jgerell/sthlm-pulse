// Trafikverket's open API: one POST endpoint taking XML queries, answering JSON.
import { config } from "./config.js";

const URL = "https://api.trafikinfo.trafikverket.se/v2/data.json";

/** Runs one query and returns its result objects. Throws on HTTP or API errors. */
export async function query<T>(objectType: string, body: string): Promise<T[]> {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body: `<REQUEST><LOGIN authenticationkey="${config.trafikverketKey}"/>${body}</REQUEST>`,
  });
  if (!res.ok) throw new Error(`Trafikverket ${objectType}: HTTP ${res.status}`);
  const json = (await res.json()) as {
    RESPONSE: { RESULT: ({ ERROR?: { MESSAGE: string } } & Record<string, T[]>)[] };
  };
  const result = json.RESPONSE.RESULT[0];
  if (result?.ERROR) throw new Error(`Trafikverket ${objectType}: ${result.ERROR.MESSAGE}`);
  return result?.[objectType] ?? [];
}

/** Escapes a value for an XML attribute. */
export const xml = (value: string) =>
  value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
