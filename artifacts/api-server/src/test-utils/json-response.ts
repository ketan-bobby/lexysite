import { z } from "zod";

// Keep every returned field, including unexpected private fields. Stripping
// response fields here would make privacy assertions falsely pass.
export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const jsonRowsSchema = z.array(jsonObjectSchema);

type JsonResponse = { json(): Promise<unknown> };

export async function readJsonObject(response: JsonResponse) {
  return jsonObjectSchema.parse(await response.json());
}

export async function readJsonRows(response: JsonResponse) {
  return jsonRowsSchema.parse(await response.json());
}
