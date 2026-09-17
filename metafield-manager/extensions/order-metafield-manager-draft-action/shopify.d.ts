import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/DraftActionExtension.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.draft-order-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/MetafieldManager.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.draft-order-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}
