export type User = {
  name: string;
  age: bigint;
  email: string;
  score: bigint;
  income: string;
  disability: boolean;
  discount?: Discount;
};

export const Discount = {
  total: "Total",
  partial_high: "Parcial Alto",
  partial_low: "Parcial Baixo",
  none: "Sem Desconto",
} as const;

export type Discount = keyof typeof Discount;
