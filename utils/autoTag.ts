import * as pulumi from '@pulumi/pulumi'
import { isTaggable } from './taggable.ts'

/**
 * registerAutoTags registers a global stack transformation that merges a set
 * of tags with whatever was also explicitly added to the resource definition.
 */
export function registerAutoTags(autoTags: Record<string, string>) {
  pulumi.runtime.registerStackTransformation((args) => {
    if (isTaggable(args.type)) {
      args.props['tags'] = { ...args.props['tags'], ...autoTags }
      return { props: args.props, opts: args.opts }
    }
    return undefined
  })
}
