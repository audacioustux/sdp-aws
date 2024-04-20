import * as k8s from '@pulumi/kubernetes'
import { objectToYaml } from './utils/yaml.ts'
import * as config from './config.ts'

const dir = 'apps'
const nm = (name: string) => `${dir}-${name}`

const provider = new k8s.Provider('render-apps-yaml', {
	renderYamlToDirectory: dir,
})

const helloWorld = new k8s.apiextensions.CustomResource(
	nm('hello-world'),
	{
		apiVersion: 'argoproj.io/v1alpha1',
		kind: 'Application',
		metadata: {
			namespace: 'argocd',
			name: 'hello-world',
		},
		spec: {
			destination: {
				namespace: 'miscellaneous',
				server: 'https://kubernetes.default.svc',
			},
			project: 'sdp',
			source: {
				repoURL: config.git.repo,
				path: `${config.git.path}/resources/hello-world`,
			},
			syncPolicy: {
				automated: {
					prune: true,
					selfHeal: true,
				},
				syncOptions: ['Validate=false', 'CreateNamespace=true', 'ServerSideApply=false'],
			},
		},
	},
	{ provider },
)

const certManager = new k8s.apiextensions.CustomResource(
	nm('cert-manager'),
	{
		apiVersion: 'argoproj.io/v1alpha1',
		kind: 'Application',
		metadata: {
			namespace: 'argocd',
			name: 'cert-manager',
		},
		spec: {
			destination: {
				namespace: 'cert-manager',
				server: 'https://kubernetes.default.svc',
			},
			project: 'sdp',
			source: {
				repoURL: 'https://charts.jetstack.io',
				chart: 'cert-manager',
				targetRevision: '*',
				helm: {
					values: objectToYaml({
						installCRDs: true,
					}),
				},
			},
			syncPolicy: {
				automated: {
					prune: true,
					selfHeal: true,
				},
				syncOptions: ['Validate=false', 'CreateNamespace=true', 'ServerSideApply=false'],
			},
		},
	},
	{ provider },
)
