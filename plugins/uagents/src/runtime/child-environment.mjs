export function childEnvironment(source = process.env, extra = {}) {
  const result = {};
  for (const [key, value] of Object.entries(source)) if (typeof value === 'string') result[key] = value;
  for (const [key, value] of Object.entries(extra)) if (typeof value === 'string') result[key] = value;
  return result;
}
