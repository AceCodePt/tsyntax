import { SUPPORTED_KEYWORDS, type DSLValidate, type SupportedKeywords } from "../../src/index.ts";
type K = SupportedKeywords;
export type R = DSLValidate<K, "`${number}${'%' | 'px'}`">;
