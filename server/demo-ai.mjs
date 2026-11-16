export const demoModel='demo-rules-v1';

// Predictable local output follows the same evidence-selection contract as Codex.
export async function demoChoice(prompt,format) {
  const context=JSON.parse(prompt).input;
  const values=Object.fromEntries(Object.entries(format.properties).map(([key,rule])=>[key,rule.enum[0]]));
  if (context&&format.properties.reasonKey.enum.includes('production')) values.reasonKey='production';
  if (!context&&format.properties.days?.enum.includes('7')) values.days='7';
  return {response:JSON.stringify(values)};
}
