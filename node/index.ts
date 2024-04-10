import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import * as eks from '@pulumi/eks'
import * as k8s from '@pulumi/kubernetes'

const organization = pulumi.getOrganization()
const project = pulumi.getProject()
const stack = pulumi.getStack()

const clusterName = `${project}-${stack}`

const tags = {
  Stack: stack,
  Project: project,
  Organization: organization
}

// === VPC ===

const vpc = new aws.ec2.Vpc(`${clusterName}-vpc`, {
  cidrBlock: '10.0.0.0/16',
  enableDnsSupport: true,
  enableDnsHostnames: true,
  tags
})

// === VPC === Subnets ===

const availabilityZones = await aws.getAvailabilityZones({ state: 'available' })
const publicSubnets = availabilityZones.names.map((az, index) => {
  return new aws.ec2.Subnet(`${clusterName}-public-${index}`, {
    vpcId: vpc.id,
    cidrBlock: `10.0.${index}.0/24`,
    availabilityZone: az,
    mapPublicIpOnLaunch: true,
    tags
  })
})

const privateSubnets = availabilityZones.names.map((az, index) => {
  return new aws.ec2.Subnet(`${clusterName}-private-${index}`, {
    vpcId: vpc.id,
    cidrBlock: `10.0.${index + 10}.0/24`,
    availabilityZone: az,
    mapPublicIpOnLaunch: false,
    tags
  })
})

// === VPC === Internet Gateway ===

const internetGateway = new aws.ec2.InternetGateway(`${clusterName}-igw`, {
  vpcId: vpc.id,
  tags
})

// === VPC === NAT Gateway ===

const eip = new aws.ec2.Eip(`${clusterName}-eip`, {
  domain: 'vpc',
  tags
})

const natGateway = new aws.ec2.NatGateway(`${clusterName}-nat`, {
  subnetId: publicSubnets[0].id,
  allocationId: eip.id,
  connectivityType: 'public',
  tags
})

// === VPC === Route Tables ===

const publicRouteTable = new aws.ec2.RouteTable(`${clusterName}-public-rt`, {
  vpcId: vpc.id,
  routes: [{
    cidrBlock: '0.0.0.0/0',
    gatewayId: internetGateway.id
  }],
  tags
})
const publicSubnetAssociations = publicSubnets.map((subnet, index) => {
  return new aws.ec2.RouteTableAssociation(`public-assoc-${index}`, {
    routeTableId: publicRouteTable.id,
    subnetId: subnet.id
  }, { parent: publicRouteTable })
})

const privateRouteTable = new aws.ec2.RouteTable(`${clusterName}-private-rt`, {
  vpcId: vpc.id,
  routes: [{
    cidrBlock: '0.0.0.0/0',
    natGatewayId: natGateway.id
  }],
  tags
})
const privateSubnetAssociations = privateSubnets.map((subnet, index) => {
  return new aws.ec2.RouteTableAssociation(`private-assoc-${index}`, {
    routeTableId: privateRouteTable.id,
    subnetId: subnet.id
  }, { parent: privateRouteTable })
})

// === KMS ===

const kmsKey = new aws.kms.Key(`${clusterName}-kms`, {
  description: 'KMS key for encrypting resources',
  deletionWindowInDays: 10,
  tags
})

// === EKS === Node Role ===

const eksNodeRole = new aws.iam.Role(`${clusterName}-node-role`, {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'ec2.amazonaws.com'
  }),
  path: '/',
  managedPolicyArns: [
    'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
    'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
    'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
    'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'
  ],
  tags
})

// === EKS === Cluster ===

const clusterVersion = '1.29'
const cluster = new eks.Cluster(clusterName, {
  name: clusterName,
  version: clusterVersion,
  vpcId: vpc.id,
  createOidcProvider: true,
  publicSubnetIds: publicSubnets.map(s => s.id),
  privateSubnetIds: privateSubnets.map(s => s.id),
  encryptionConfigKeyArn: kmsKey.arn,
  nodeAssociatePublicIpAddress: false,
  defaultAddonsToRemove: ['kube-proxy'],
  nodeGroupOptions: {
    taints: {
      'node.cilium.io/agent-not-ready': {
        value: 'true',
        effect: 'NoExecute'
      }
    }
  },
  roleMappings: [
    {
      roleArn: eksNodeRole.arn,
      username: 'system:node:{{EC2PrivateDNSName}}',
      groups: ['system:bootstrappers', 'system:nodes']
    }
  ],
  tags: {
    ...tags,
    'karpenter.sh/discovery': clusterName
  }
})

const k8sProvider = new k8s.Provider(clusterName, {
  kubeconfig: cluster.kubeconfigJson,
  enableServerSideApply: true
})

// === EKS === Node Group ===

const defaultNodeGroupName = 'default-node-group'
const defaultNodeGroup = new eks.ManagedNodeGroup(defaultNodeGroupName, {
  cluster,
  instanceTypes: ['m7g.medium'],
  capacityType: 'SPOT',
  amiType: 'BOTTLEROCKET_ARM_64',
  nodeRole: cluster.instanceRoles[0],
  scalingConfig: {
    minSize: 0,
    maxSize: 2,
    desiredSize: 2
  },
  tags
})

// === EKS === Addons === CoreDNS ===

const coreDNSAddonName = 'coredns'
const coreDNSAddon = new aws.eks.Addon(coreDNSAddonName, {
  addonName: coreDNSAddonName,
  clusterName: cluster.eksCluster.name,
  addonVersion: (await aws.eks.getAddonVersion({
    addonName: coreDNSAddonName,
    kubernetesVersion: clusterVersion,
    mostRecent: true
  })).version,
  resolveConflictsOnCreate: 'OVERWRITE'
})

// === EKS === Addons === VPC CNI ===

const vpcCniAddonName = 'vpc-cni'
const vpcCniAddon = new aws.eks.Addon(vpcCniAddonName, {
  addonName: vpcCniAddonName,
  clusterName: cluster.eksCluster.name,
  addonVersion: (await aws.eks.getAddonVersion({
    addonName: vpcCniAddonName,
    kubernetesVersion: clusterVersion,
    mostRecent: true
  })).version,
  resolveConflictsOnCreate: 'OVERWRITE'
})
const awsNodeDaemonSetPatch = new k8s.apps.v1.DaemonSetPatch('aws-node-patch', {
  metadata: {
    namespace: 'kube-system',
    name: 'aws-node'
  },
  spec: {
    template: {
      spec: {
        nodeSelector: {
          'io.cilium/aws-node-enabled': 'true'
        }
      }
    }
  }
}, { provider: k8sProvider, retainOnDelete: true })

// === EKS === Addons === EBS CSI Driver ===

const ebsCsiDriverRoleName = `${clusterName}-ebs-csi-driver-irsa`
const ebsCsiDriverRole = new aws.iam.Role(ebsCsiDriverRoleName, {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'ec2.amazonaws.com'
  }),
  tags
})
const policyAttachment = new aws.iam.RolePolicyAttachment(`${ebsCsiDriverRoleName}-attachment`, {
  role: ebsCsiDriverRole,
  policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy'
})
const csiDriverAddonName = 'aws-ebs-csi-driver'
const ebsCsiAddon = new aws.eks.Addon(csiDriverAddonName, {
  addonName: csiDriverAddonName,
  clusterName: cluster.eksCluster.name,
  addonVersion: (await aws.eks.getAddonVersion({
    addonName: csiDriverAddonName,
    kubernetesVersion: clusterVersion,
    mostRecent: true
  })).version,
  serviceAccountRoleArn: ebsCsiDriverRole.arn,
  resolveConflictsOnCreate: 'OVERWRITE'
})

// === EKS === Addons === Pod Identity Agent ===

const podIdentityAgentAddonName = 'eks-pod-identity-agent'
const podIdentityAgentAddon = new aws.eks.Addon(podIdentityAgentAddonName, {
  addonName: podIdentityAgentAddonName,
  clusterName: cluster.eksCluster.name,
  addonVersion: (await aws.eks.getAddonVersion({
    addonName: podIdentityAgentAddonName,
    kubernetesVersion: clusterVersion,
    mostRecent: true
  })).version,
  resolveConflictsOnCreate: 'OVERWRITE'
})

// === EKS === Gateway API ===

const gatewayAPIController = new k8s.yaml.ConfigFile('gateway-api-controller', {
  file: 'https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.0.0/standard-install.yaml'
}, { provider: k8sProvider })

// === EKS === Cilium ===

const k8sServiceHosts = k8s.core.v1.Endpoints.get('kubernetes-endpoint', 'kubernetes', { provider: k8sProvider }).subsets.apply(subsets =>
  subsets.map(subset => subset.addresses.map(address => address.ip)).flat()
)
const ciliumChartName = 'cilium'
const cilium = new k8s.helm.v3.Release(ciliumChartName, {
  chart: ciliumChartName,
  namespace: 'kube-system',
  repositoryOpts: {
    repo: 'https://helm.cilium.io'
  },
  values: {
    kubeProxyReplacement: 'strict',
    k8sServiceHost: k8sServiceHosts[0],
    ingressController: {
      enabled: true,
      loadbalancerMode: 'dedicated',
      default: true
    },
    hubble: {
      relay: {
        enabled: true
      },
      ui: {
        enabled: true
      }
    },
    loadBalancer: {
      algorithm: 'maglev',
      l7: {
        backend: 'envoy'
      }
    },
    gatewayAPI: {
      enabled: true
    },
    routingMode: 'native',
    bpf: {
      masquerade: true
    },
    ipam: {
      mode: 'eni'
    },
    eni: {
      enabled: true,
      awsEnablePrefixDelegation: true
    }
  }
}, { provider: k8sProvider, dependsOn: [gatewayAPIController, awsNodeDaemonSetPatch] })

// === EC2 === Interruption Queue ===

const EC2InterruptionQueueName = `${clusterName}-ec2-interruption-queue`
const EC2InterruptionQueue = new aws.sqs.Queue(EC2InterruptionQueueName, {
  name: EC2InterruptionQueueName,
  messageRetentionSeconds: 300,
  sqsManagedSseEnabled: true,
  tags
})
const EC2InterruptionQueuePolicyName = `${EC2InterruptionQueueName}-policy`
const EC2InterruptionQueuePolicy = new aws.sqs.QueuePolicy(EC2InterruptionQueuePolicyName, {
  queueUrl: EC2InterruptionQueue.id,
  policy: {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {
          Service: ['events.amazonaws.com', 'sqs.amazonaws.com']
        },
        Action: 'sqs:SendMessage',
        Resource: EC2InterruptionQueue.arn
      }
    ]
  }
})

const scheduledChangeRuleName = `${clusterName}-scheduled-change-rule`
const scheduledChangeRule = new aws.cloudwatch.EventRule(scheduledChangeRuleName, {
  name: scheduledChangeRuleName,
  eventPattern: JSON.stringify({
    source: ['aws.health'],
    'detail-type': ['AWS Health Event']
  }),
  tags
})
const scheduledChangeTarget = new aws.cloudwatch.EventTarget(scheduledChangeRuleName, {
  rule: scheduledChangeRule.name,
  arn: EC2InterruptionQueue.arn
})

const spotInterruptionRuleName = `${clusterName}-spot-interruption-rule`
const spotInterruptionRule = new aws.cloudwatch.EventRule(spotInterruptionRuleName, {
  name: spotInterruptionRuleName,
  eventPattern: JSON.stringify({
    source: ['aws.ec2'],
    'detail-type': ['EC2 Spot Instance Interruption Warning']
  }),
  tags
})
const spotInterruptionTarget = new aws.cloudwatch.EventTarget(spotInterruptionRuleName, {
  rule: spotInterruptionRule.name,
  arn: EC2InterruptionQueue.arn
})

const rebalanceRuleName = `${clusterName}-rebalance-rule`
const rebalanceRule = new aws.cloudwatch.EventRule(rebalanceRuleName, {
  name: rebalanceRuleName,
  eventPattern: JSON.stringify({
    source: ['aws.ec2'],
    'detail-type': ['EC2 Instance Rebalance Recommendation']
  }),
  tags
})
const rebalanceTarget = new aws.cloudwatch.EventTarget(rebalanceRuleName, {
  rule: rebalanceRule.name,
  arn: EC2InterruptionQueue.arn
})

const instanceStateChangeRuleName = `${clusterName}-instance-state-change-rule`
const instanceStateChangeRule = new aws.cloudwatch.EventRule(instanceStateChangeRuleName, {
  name: instanceStateChangeRuleName,
  eventPattern: JSON.stringify({
    source: ['aws.ec2'],
    'detail-type': ['EC2 Instance State-change Notification']
  }),
  tags
})
const instanceStateChangeTarget = new aws.cloudwatch.EventTarget(instanceStateChangeRuleName, {
  rule: instanceStateChangeRule.name,
  arn: EC2InterruptionQueue.arn
})

// === EKS === Karpenter === Controller Role ===

const karpenterControllerPolicy = (partitionId: string, regionId: string, accountId: string, clusterName: string, nodeRoleName: string) => aws.iam.getPolicyDocumentOutput({
  statements: [
    {
      sid: 'AllowScopedEC2InstanceAccessActions',
      effect: 'Allow',
      resources: [
        `arn:${partitionId}:ec2:${regionId}::image/*`,
        `arn:${partitionId}:ec2:${regionId}::snapshot/*`,
        `arn:${partitionId}:ec2:${regionId}:*:security-group/*`,
        `arn:${partitionId}:ec2:${regionId}:*:subnet/*`
      ],
      actions: [
        'ec2:RunInstances',
        'ec2:CreateFleet'
      ]
    },
    {
      sid: 'AllowScopedEC2LaunchTemplateAccessActions',
      effect: 'Allow',
      resources: [`arn:${partitionId}:ec2:${regionId}:*:launch-template/*`],
      actions: [
        'ec2:RunInstances',
        'ec2:CreateFleet'
      ],
      conditions: [
        {
          test: 'StringEquals',
          variable: `aws:ResourceTag/kubernetes.io/cluster/${clusterName}`,
          values: ['owned']
        },
        {
          test: 'StringLike',
          variable: 'aws:ResourceTag/karpenter.sh/nodepool',
          values: ['*']
        }
      ]
    },
    {
      sid: 'AllowScopedEC2InstanceActionsWithTags',
      effect: 'Allow',
      resources: [
        `arn:${partitionId}:ec2:${regionId}:*:fleet/*`,
        `arn:${partitionId}:ec2:${regionId}:*:instance/*`,
        `arn:${partitionId}:ec2:${regionId}:*:volume/*`,
        `arn:${partitionId}:ec2:${regionId}:*:network-interface/*`,
        `arn:${partitionId}:ec2:${regionId}:*:launch-template/*`,
        `arn:${partitionId}:ec2:${regionId}:*:spot-instances-request/*`
      ],
      actions: [
        'ec2:RunInstances',
        'ec2:CreateFleet',
        'ec2:CreateLaunchTemplate'
      ],
      conditions: [
        {
          test: 'StringEquals',
          variable: `aws:RequestTag/kubernetes.io/cluster/${clusterName}`,
          values: ['owned']
        },
        {
          test: 'StringLike',
          variable: 'aws:RequestTag/karpenter.sh/nodepool',
          values: ['*']
        }
      ]
    },
    {
      sid: 'AllowScopedResourceCreationTagging',
      effect: 'Allow',
      resources: [
        `arn:${partitionId}:ec2:${regionId}:*:fleet/*`,
        `arn:${partitionId}:ec2:${regionId}:*:instance/*`,
        `arn:${partitionId}:ec2:${regionId}:*:volume/*`,
        `arn:${partitionId}:ec2:${regionId}:*:network-interface/*`,
        `arn:${partitionId}:ec2:${regionId}:*:launch-template/*`,
        `arn:${partitionId}:ec2:${regionId}:*:spot-instances-request/*`
      ],
      actions: ['ec2:CreateTags'],
      conditions: [
        {
          test: 'StringEquals',
          variable: `aws:RequestTag/kubernetes.io/cluster/${clusterName}`,
          values: ['owned']
        },
        {
          test: 'StringEquals',
          variable: 'ec2:CreateAction',
          values: ['RunInstances', 'CreateFleet', 'CreateLaunchTemplate']
        },
        {
          test: 'StringLike',
          variable: 'aws:RequestTag/karpenter.sh/nodepool',
          values: ['*']
        }
      ]
    },
    {
      sid: 'AllowScopedResourceTagging',
      effect: 'Allow',
      resources: [`arn:${partitionId}:ec2:${regionId}:*:instance/*`],
      actions: ['ec2:CreateTags'],
      conditions: [
        {
          test: 'StringEquals',
          variable: `aws:ResourceTag/kubernetes.io/cluster/${clusterName}`,
          values: ['owned']
        },
        {
          test: 'StringLike',
          variable: 'aws:ResourceTag/karpenter.sh/nodepool',
          values: ['*']
        },
        {
          test: 'ForAllValues:StringEquals',
          variable: 'aws:TagKeys',
          values: ['karpenter.sh/nodeclaim', 'Name']
        }
      ]
    },
    {
      sid: 'AllowScopedDeletion',
      effect: 'Allow',
      resources: [
        `arn:${partitionId}:ec2:${regionId}:*:instance/*`,
        `arn:${partitionId}:ec2:${regionId}:*:launch-template/*`
      ],
      actions: [
        'ec2:TerminateInstances',
        'ec2:DeleteLaunchTemplate'
      ],
      conditions: [
        {
          test: 'StringEquals',
          variable: `aws:ResourceTag/kubernetes.io/cluster/${clusterName}`,
          values: ['owned']
        },
        {
          test: 'StringLike',
          variable: 'aws:ResourceTag/karpenter.sh/nodepool',
          values: ['*']
        }
      ]
    },
    {
      sid: 'AllowRegionalReadActions',
      effect: 'Allow',
      resources: ['*'],
      actions: [
        'ec2:DescribeAvailabilityZones',
        'ec2:DescribeImages',
        'ec2:DescribeInstances',
        'ec2:DescribeInstanceTypeOfferings',
        'ec2:DescribeInstanceTypes',
        'ec2:DescribeLaunchTemplates',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeSpotPriceHistory',
        'ec2:DescribeSubnets'
      ],
      conditions: [
        {
          test: 'StringEquals',
          variable: 'aws:RequestedRegion',
          values: [regionId]
        }
      ]
    },
    {
      sid: 'AllowSSMReadActions',
      effect: 'Allow',
      resources: [`arn:${partitionId}:ssm:${regionId}::parameter/aws/service/*`],
      actions: ['ssm:GetParameter']
    },
    {
      sid: 'AllowPricingReadActions',
      effect: 'Allow',
      resources: ['*'],
      actions: ['pricing:GetProducts']
    },
    {
      sid: 'AllowInterruptionQueueActions',
      effect: 'Allow',
      resources: [`arn:${partitionId}:sqs:${regionId}:${accountId}:${EC2InterruptionQueueName}`],
      actions: [
        'sqs:DeleteMessage',
        'sqs:GetQueueUrl',
        'sqs:ReceiveMessage'
      ]
    },
    {
      sid: 'AllowPassingInstanceRole',
      effect: 'Allow',
      resources: [`arn:${partitionId}:iam::${accountId}:role/${nodeRoleName}`],
      actions: ['iam:PassRole'],
      conditions: [
        {
          test: 'StringEquals',
          variable: 'iam:PassedToService',
          values: ['ec2.amazonaws.com']
        }
      ]
    },
    {
      sid: 'AllowScopedInstanceProfileCreationActions',
      effect: 'Allow',
      resources: ['*'],
      actions: ['iam:CreateInstanceProfile'],
      conditions: [
        {
          test: 'StringEquals',
          variable: `aws:RequestTag/kubernetes.io/cluster/${clusterName}`,
          values: ['owned']
        },
        {
          test: 'StringEquals',
          variable: 'aws:RequestTag/topology.kubernetes.io/region',
          values: [regionId]
        },
        {
          test: 'StringLike',
          variable: 'aws:RequestTag/karpenter.k8s.aws/ec2nodeclass',
          values: ['*']
        }
      ]
    },
    {
      sid: 'AllowScopedInstanceProfileTagActions',
      effect: 'Allow',
      resources: ['*'],
      actions: ['iam:TagInstanceProfile'],
      conditions: [
        {
          test: 'StringEquals',
          variable: `aws:ResourceTag/kubernetes.io/cluster/${clusterName}`,
          values: ['owned']
        },
        {
          test: 'StringEquals',
          variable: 'aws:ResourceTag/topology.kubernetes.io/region',
          values: [regionId]
        },
        {
          test: 'StringEquals',
          variable: `aws:RequestTag/kubernetes.io/cluster/${clusterName}`,
          values: ['owned']
        },
        {
          test: 'StringEquals',
          variable: 'aws:RequestTag/topology.kubernetes.io/region',
          values: [regionId]
        },
        {
          test: 'StringLike',
          variable: 'aws:ResourceTag/karpenter.k8s.aws/ec2nodeclass',
          values: ['*']
        },
        {
          test: 'StringLike',
          variable: 'aws:RequestTag/karpenter.k8s.aws/ec2nodeclass',
          values: ['*']
        }
      ]
    },
    {
      sid: 'AllowScopedInstanceProfileActions',
      effect: 'Allow',
      resources: ['*'],
      actions: [
        'iam:AddRoleToInstanceProfile',
        'iam:RemoveRoleFromInstanceProfile',
        'iam:DeleteInstanceProfile'
      ],
      conditions: [
        {
          test: 'StringEquals',
          variable: `aws:ResourceTag/kubernetes.io/cluster/${clusterName}`,
          values: ['owned']
        },
        {
          test: 'StringEquals',
          variable: 'aws:ResourceTag/topology.kubernetes.io/region',
          values: [regionId]
        },
        {
          test: 'StringLike',
          variable: 'aws:ResourceTag/karpenter.k8s.aws/ec2nodeclass',
          values: ['*']
        }
      ]
    },
    {
      sid: 'AllowInstanceProfileReadActions',
      effect: 'Allow',
      resources: ['*'],
      actions: ['iam:GetInstanceProfile']
    },
    {
      sid: 'AllowAPIServerEndpointDiscovery',
      effect: 'Allow',
      resources: [`arn:${partitionId}:eks:${regionId}:${accountId}:cluster/${clusterName}`],
      actions: ['eks:DescribeCluster']
    }
  ]
})

const partitionId = await aws.getPartition().then(partition => partition.id)
const regionId = await aws.getRegion().then(region => region.id)
const accountId = await aws.getCallerIdentity().then(identity => identity.accountId)

const karpenterControllerPolicyName = `karpenter-controller-policy`
const KarpenterControllerPolicy = new aws.iam.Policy(karpenterControllerPolicyName, {
  policy: karpenterControllerPolicy(partitionId, regionId, accountId, clusterName, eksNodeRole.name.get()).json,
  tags
})
const karpenterControllerRoleName = `karpenter-controller-role`
const karpenterControllerRole = new aws.iam.Role(karpenterControllerRoleName, {
  assumeRolePolicy: {
    Version: '2012-10-17',
    Statement: [{
      Action: [
        'sts:AssumeRole',
        'sts:TagSession'
      ],
      Effect: 'Allow',
      Principal: {
        Service: 'pods.eks.amazonaws.com'
      }
    }]
  },
  tags
})
const karpenterControllerRolePolicyAttachment = new aws.iam.RolePolicyAttachment(`${karpenterControllerRoleName}-attachment`, {
  policyArn: KarpenterControllerPolicy.arn,
  role: karpenterControllerRole
})

const podIdentityAssociationName = `pod-identity-association`
const podIdentityAssociation = new aws.eks.PodIdentityAssociation(podIdentityAssociationName, {
  clusterName: cluster.eksCluster.name,
  namespace: 'kube-system',
  serviceAccount: 'karpenter',
  roleArn: karpenterControllerRole.arn,
  tags
})

// === EKS === Karpenter ===

const karpenterChartName = 'karpenter'
const karpenter = new k8s.helm.v3.Release(karpenterChartName, {
  chart: 'oci://public.ecr.aws/karpenter/karpenter',
  name: karpenterChartName,
  namespace: 'kube-system',
  values: {
    settings: {
      clusterName: cluster.eksCluster.name,
      interruptionQueue: EC2InterruptionQueue.name,
      featureGates: {
        spotToSpotConsolidation: true
      }
    }
  }
}, { provider: k8sProvider })

// === EKS === Karpenter === Node Class ===

const defaultNodeClassName = `${clusterName}-default-node-class`
const defaultNodeClass = new k8s.apiextensions.CustomResource(defaultNodeClassName, {
  apiVersion: 'karpenter.k8s.aws/v1beta1',
  kind: 'EC2NodeClass',
  metadata: {
    name: defaultNodeClassName
  },
  spec: {
    amiFamily: 'Bottlerocket',
    role: eksNodeRole.name,
    associatePublicIPAddress: false,
    subnetSelectorTerms: [
      {
        tags: {
          'karpenter.sh/discovery': cluster.eksCluster.name
        }
      }
    ],
    securityGroupSelectorTerms: [
      {
        tags: {
          'karpenter.sh/discovery': cluster.eksCluster.name
        }
      }
    ]
  }
}, { provider: k8sProvider, dependsOn: [karpenter] })

// === EKS === Karpenter === Node Pool ===

const defaultNodePoolName = `${clusterName}-default-node-pool`
const defaultNodePool = new k8s.apiextensions.CustomResource(defaultNodePoolName, {
  apiVersion: 'karpenter.sh/v1beta1',
  kind: 'NodePool',
  metadata: {
    name: defaultNodePoolName
  },
  spec: {
    template: {
      spec: {
        requirements: [
          {
            key: 'kubernetes.io/arch',
            operator: 'In',
            values: ['arm64']
          },
          {
            key: 'kubernetes.io/os',
            operator: 'In',
            values: ['linux']
          },
          {
            key: 'karpenter.sh/capacity-type',
            operator: 'In',
            values: ['spot', 'on-demand']
          },
          {
            key: 'karpenter.k8s.aws/instance-category',
            operator: 'In',
            values: ['m', 't']
          }
        ],
        nodeClassRef: {
          apiVersion: 'karpenter.k8s.aws/v1beta1',
          kind: 'EC2NodeClass',
          name: defaultNodeClass.metadata.name
        }
      }
    },
    limits: {
      cpu: 10
    },
    disruption: {
      consolidationPolicy: 'WhenUnderutilized',
      expireAfter: '720h'
    }
  }
}, { provider: k8sProvider, dependsOn: [karpenter] })

export const kubeconfig = cluster.kubeconfig
