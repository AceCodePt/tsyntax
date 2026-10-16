import { SUPPORTED_KEYWORDS, type DSLInfer, type SupportedKeywords } from "../../src/index.ts";
type K = SupportedKeywords & {
  "<length>": "`${number}${'%' | 'px'}`",
};
export type R = DSLInfer<K, "<length>">;
