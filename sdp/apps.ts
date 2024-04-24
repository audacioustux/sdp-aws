import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'
import * as R from 'ramda'

const dir = 'apps'
const nm = (name: string) => `${dir}-${name}`

const provider = new k8s.Provider('render-apps-yaml', {
  renderYamlToDirectory: dir,
})

export class ArgoApp extends k8s.apiextensions.CustomResource {
  constructor(name: string, spec: Record<string, NonNullable<unknown>>, opts: pulumi.CustomResourceOptions = {}) {
    const defaultSpec = {
      destination: {
        namespace: 'default',
        server: 'https://kubernetes.default.svc',
      },
      project: 'default',
      syncPolicy: {
        automated: {
          prune: true,
          selfHeal: true,
        },
      },
    }

    super(
      nm(name),
      {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Application',
        metadata: {
          namespace: 'argocd',
          name,
        },
        spec: R.mergeDeepRight(defaultSpec, spec),
      },
      R.mergeRight({ provider }, opts),
    )
  }
}
