// The panel itself lives in apps/metafield-manager/shared/MetafieldManager.jsx.
//
// All four extensions (draft block, draft action, order block, order action) render the SAME
// ~970-line component; only the target in shopify.extension.toml and the `surface` prop differ.
// They used to be four byte-identical copies, so every change had to be pasted four times —
// the installment-table work did exactly that, four times, in one commit.
//
// This re-export keeps each extension's entry path unchanged while giving the component one home.
export { default } from "../../../shared/MetafieldManager.jsx";
