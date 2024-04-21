import * as k8s from '@pulumi/kubernetes'

const dir = 'apps'
const nm = (name: string) => `${dir}-${name}`

const provider = new k8s.Provider('render-apps-yaml', {
	renderYamlToDirectory: dir,
})

export class ArgoApp extends k8s.apiextensions.CustomResource {
	constructor(name: string, spec: Record<string, any>) {
		super(
			nm(name),
			{
				apiVersion: 'argoproj.io/v1alpha1',
				kind: 'Application',
				metadata: {
					namespace: 'argocd',
					name,
				},
				spec,
			},
			{ provider },
		)
	}
}
