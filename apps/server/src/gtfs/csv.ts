import { createReadStream } from "node:fs";
import { parse } from "csv-parse";

/** Streams a GTFS CSV file row by row, keyed by column name. */
export async function* readCsv(path: string): AsyncGenerator<Record<string, string>> {
  const parser = createReadStream(path).pipe(
    parse({ columns: true, bom: true, skip_empty_lines: true }),
  );
  for await (const row of parser) {
    yield row as Record<string, string>;
  }
}
