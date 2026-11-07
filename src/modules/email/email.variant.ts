// "Standard" is the placeholder colour the catalogue stores when a variant has no real colour
// (see catalogue.service normaliseVariants). It is not a colour a customer chose, so it is left out
// of the line detail in emails. Real colours are still shown.
export const PLACEHOLDER_COLOUR = "Standard";

/** "Size M · Green" style detail for an order line, omitting the placeholder colour. */
export function variantDetail(size: string | null | undefined, colour: string | null | undefined): string {
  const cleanColour = colour && colour.trim() && colour.trim().toLowerCase() !== PLACEHOLDER_COLOUR.toLowerCase() ? colour.trim() : null;
  return [size && `Size ${size}`, cleanColour].filter(Boolean).join(" · ");
}
