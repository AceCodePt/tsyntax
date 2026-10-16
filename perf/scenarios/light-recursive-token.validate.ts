import { SUPPORTED_KEYWORDS, type DSLValidate, type SupportedKeywords } from "../../src/index.ts";
type K = SupportedKeywords & {
  "<length>": "`${number}${'%' | 'px'}`",
};
export type R = DSLValidate<K, "<length>">;
