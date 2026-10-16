import { type DSLInfer, type SupportedKeywords } from "@impl";
type K = SupportedKeywords & {
  "<length>": "`${number}${'%' | 'px'}`",
};
export type R = DSLInfer<K, "<length>">;
