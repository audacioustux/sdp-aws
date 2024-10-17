import { getProject, getOrganization, getStack, Config } from '@pulumi/pulumi'

const organization = getOrganization()
const project = getProject()
const stack = getStack()
const pulumi = { organization, project, stack }

const defaults = {
  tagsAll: Object.fromEntries(Object.entries(pulumi).map(([k, v]) => [`pulumi:${k}`, v])),
  pod: {
    resources: {
      requests: {
        memory: '64Mi',
      },
      limits: {
        memory: '256Mi',
      },
    },
  },
}

const grafanaConfig = new Config('grafana')
const grafana = {
  host: grafanaConfig.require('host'),
}

const argocdConfig = new Config('argocd')
const argocd = {
  host: argocdConfig.require('host'),
}

const argoWorkflowsConfig = new Config('argo-workflows')
const argoWorkflows = {
  host: argoWorkflowsConfig.require('host'),
}

const adminConfig = new Config('admin')
const admin = {
  email: adminConfig.require('email'),
}

const route53Config = new Config('route53')
const route53 = {
  zones: route53Config.requireObject<string[]>('zones'),
  region: route53Config.require('region'),
}

const dockerRegistryConfig = new Config('dockerio')
const dockerRegistry = {
  username: dockerRegistryConfig.require('username'),
  token: dockerRegistryConfig.requireSecret('token'),
}

const zerosslConfig = new Config('zerossl')
const zerossl = {
  key: zerosslConfig.require('key'),
  secret: zerosslConfig.requireSecret('secret'),
}
// TODO: move hard-coded configs in index.ts to here

export { pulumi, grafana, defaults, argocd, admin, route53, dockerRegistry, zerossl, argoWorkflows }
