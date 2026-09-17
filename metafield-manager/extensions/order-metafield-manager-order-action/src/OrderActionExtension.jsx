import "@shopify/ui-extensions/preact";
import { render } from "preact";
import MetafieldManager from "./MetafieldManager.jsx";

export default async () => {
  render(<MetafieldManager surface="action" />, document.body);
};
