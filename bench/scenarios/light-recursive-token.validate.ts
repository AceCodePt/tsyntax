import { type DSLValidate, type SupportedKeywords } from "@impl";
type K = SupportedKeywords & {
  "<length>": "`${number}${'%' | 'px'}`",
};
export type R = DSLValidate<K, "<length>">;
