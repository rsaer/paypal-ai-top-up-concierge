export type Credentials = {
  client_id: string;
  client_secret: string;
  merchant_id: string;
};

export type MenuItem = {
  name: string;
  /** Integer minor units (cents). 700 = $7.00. */
  price_minor: number;
  currency: string;
};

export type TopupIntent = {
  id: string;
  order_id: string;
  amount_minor: number;
  currency: string;
  status: "pending" | "credited";
};
