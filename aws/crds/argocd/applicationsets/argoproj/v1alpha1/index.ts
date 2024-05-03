// *** WARNING: this file was generated by crd2pulumi. ***
// *** Do not edit by hand unless you're certain you know what you are doing! ***

import * as pulumi from '@pulumi/pulumi'
import * as utilities from '../../utilities'

// Export members:
export { ApplicationSetArgs } from './applicationSet'
export type ApplicationSet = import('./applicationSet').ApplicationSet
export const ApplicationSet: typeof import('./applicationSet').ApplicationSet = null as any
utilities.lazyLoad(exports, ['ApplicationSet'], () => require('./applicationSet'))

const _module = {
  version: utilities.getVersion(),
  construct: (name: string, type: string, urn: string): pulumi.Resource => {
    switch (type) {
      case 'kubernetes:argoproj.io/v1alpha1:ApplicationSet':
        return new ApplicationSet(name, <any>undefined, { urn })
      default:
        throw new Error(`unknown resource type ${type}`)
    }
  },
}
pulumi.runtime.registerResourceModule('crds', 'argoproj.io/v1alpha1', _module)
