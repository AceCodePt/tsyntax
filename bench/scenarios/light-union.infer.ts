import { type DSLInfer, type SupportedKeywords } from "@impl";
type K = SupportedKeywords;
export type R = DSLInfer<K, "'ltr' | 'rtl' | 'center' | 'justify'">;
