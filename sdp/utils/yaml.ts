import { stringify } from 'yaml'

export const objectToYaml = (obj: Record<string, any>, indent = 4, lineWidth = 20): string => {
	return stringify(obj, { indent, lineWidth })
}
