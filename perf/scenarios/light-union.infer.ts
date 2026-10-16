import { SUPPORTED_KEYWORDS, type DSLInfer, type SupportedKeywords } from "../../src/index.ts";
type K = SupportedKeywords;
export type R = DSLInfer<K, "'ltr' | 'rtl' | 'center' | 'justify'">;
