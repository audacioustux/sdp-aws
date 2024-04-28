import { stringify } from 'yaml'

export const objectToYaml = (
  obj: Record<string, NonNullable<unknown>> | unknown[],
  indent = 4,
  lineWidth = 20,
): string => {
  return stringify(obj, { indent, lineWidth })
}
