import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import * as eks from '@pulumi/eks'
import * as k8s from '@pulumi/kubernetes'

const stackName = `${pulumi.getProject()}-${pulumi.getStack()}`

// === VPC ===

const vpc = new aws.ec2.Vpc(stackName, {
  cidrBlock: '10.0.0.0/16',
  enableDnsSupport: true,
  enableDnsHostnames: true,
  tags: {
    Name: stackName
  }
})

// === VPC === Subnets ===

const availabilityZones = await aws.getAvailabilityZones({ state: 'available' })
const publicSubnets = availabilityZones.names.map((az, index) => {
  const subnetName = `${stackName}-public-${index}`
  return new aws.ec2.Subnet(subnetName, {
    vpcId: vpc.id,
    cidrBlock: `10.0.${index}.0/24`,
    availabilityZone: az,
    mapPublicIpOnLaunch: true,
    tags: {
      Name: subnetName
    }
  })
})

const privateSubnets = availabilityZones.names.map((az, index) => {
  const subnetName = `${stackName}-private-${index}`
  return new aws.ec2.Subnet(subnetName, {
    vpcId: vpc.id,
    cidrBlock: `10.0.${index + 10}.0/24`,
    availabilityZone: az,
    mapPublicIpOnLaunch: false,
    tags: {
      Name: subnetName,
      'karpenter.sh/discovery': stackName
    }
  })
})

// === VPC === Internet Gateway ===

const internetGateway = new aws.ec2.InternetGateway(stackName, {
  vpcId: vpc.id,
  tags: {
    Name: stackName
  }
})

// === VPC === NAT Gateway ===

const eip = new aws.ec2.Eip(stackName, {
  domain: 'vpc',
  tags: {
    Name: stackName
  }
})

const natGateway = new aws.ec2.NatGateway(stackName, {
  subnetId: publicSubnets[0].id,
  allocationId: eip.id,
  connectivityType: 'public',
  tags: {
    Name: stackName
  }
})

// === VPC === Route Tables ===

const publicRouteTableName = `${stackName}-public`
const publicRouteTable = new aws.ec2.RouteTable(publicRouteTableName, {
  vpcId: vpc.id,
  routes: [{
    cidrBlock: '0.0.0.0/0',
    gatewayId: internetGateway.id
  }],
  tags: {
    Name: publicRouteTableName
  }
})
const publicSubnetAssociations = publicSubnets.map((subnet, index) => {
  return new aws.ec2.RouteTableAssociation(`public-assoc-${index}`, {
    routeTableId: publicRouteTable.id,
    subnetId: subnet.id
  }, { parent: publicRouteTable })
})

const privateRouteTableName = `${stackName}-private`
const privateRouteTable = new aws.ec2.RouteTable(privateRouteTableName, {
  vpcId: vpc.id,
  routes: [{
    cidrBlock: '0.0.0.0/0',
    natGatewayId: natGateway.id
  }],
  tags: {
    Name: privateRouteTableName
  }
})
const privateSubnetAssociations = privateSubnets.map((subnet, index) => {
  return new aws.ec2.RouteTableAssociation(`private-assoc-${index}`, {
    routeTableId: privateRouteTable.id,
    subnetId: subnet.id
  }, { parent: privateRouteTable })
})

// === KMS ===

const kmsKey = new aws.kms.Key(stackName, {
  description: `KMS key for ${stackName}`,
  deletionWindowInDays: 10,
})
new aws.kms.Alias(stackName, {
  name: `alias/${stackName}`,
  targetKeyId: kmsKey.id
})

// === EKS === Node Role ===

const eksNodeRoleName = `${stackName}-node-role`
const eksNodeRole = new aws.iam.Role(eksNodeRoleName, {
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
})

// === EKS === Cluster ===

const {
  provider,
  eksCluster,
  core: cluster,
  kubeconfigJson
} = new eks.Cluster(stackName, {
  name: stackName,
  version: '1.29',
  vpcId: vpc.id,
  createOidcProvider: true,
  publicSubnetIds: publicSubnets.map(s => s.id),
  privateSubnetIds: privateSubnets.map(s => s.id),
  encryptionConfigKeyArn: kmsKey.arn,
  defaultAddonsToRemove: ['kube-proxy'],
  skipDefaultNodeGroup: true,
  vpcCniOptions: {
    enablePrefixDelegation: true
  },
  nodeGroupOptions: {
    nodeAssociatePublicIpAddress: false,
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
    'karpenter.sh/discovery': stackName
  }
})

// === EKS === Node Group ===

const highPriorityNodeGroupName = `${stackName}-high-priority`
const highPriorityNodeGroup = new eks.ManagedNodeGroup(highPriorityNodeGroupName, {
  nodeGroupName: highPriorityNodeGroupName,
  cluster,
  instanceTypes: ['m7g.medium', 't4g.medium', 'c7g.medium'],
  capacityType: 'SPOT',
  amiType: 'BOTTLEROCKET_ARM_64',
  nodeRole: cluster.instanceRoles[0],
  scalingConfig: {
    minSize: 3,
    maxSize: 3,
    desiredSize: 3
  },
})

// === EKS === Addons === CoreDNS ===

const coreDNSAddonName = 'coredns'
const coreDNSAddon = new aws.eks.Addon(coreDNSAddonName, {
  addonName: coreDNSAddonName,
  clusterName: eksCluster.name,
  addonVersion: eksCluster.version.apply(version => aws.eks.getAddonVersion({
    addonName: coreDNSAddonName,
    kubernetesVersion: version,
    mostRecent: true
  })).version,
  configurationValues: JSON.stringify({
    corefile: `.:53 {
      errors
      log
      health {
        lameduck 30s
      }
      ready
      kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
      }
      prometheus :9153
      forward . /etc/resolv.conf
      cache 30
      loop
      reload
      loadbalance
    }`
  }),
  resolveConflictsOnCreate: 'OVERWRITE'
})

// === EKS === Addons === VPC CNI ===

const vpcCniAddonName = 'vpc-cni'
const vpcCniAddon = new aws.eks.Addon(vpcCniAddonName, {
  addonName: vpcCniAddonName,
  clusterName: eksCluster.name,
  addonVersion: eksCluster.version.apply(async kubernetesVersion =>
    await aws.eks.getAddonVersion({
      addonName: vpcCniAddonName,
      kubernetesVersion,
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
}, { provider, retainOnDelete: true, dependsOn: vpcCniAddon })

// === EKS === Addons === EBS CSI Driver ===

const ebsCsiDriverRoleName = `${stackName}-ebs-csi-driver-irsa`
const ebsCsiDriverRole = new aws.iam.Role(ebsCsiDriverRoleName, {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'ec2.amazonaws.com'
  }),
})
const policyAttachment = new aws.iam.RolePolicyAttachment(`${ebsCsiDriverRoleName}-attachment`, {
  role: ebsCsiDriverRole,
  policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy'
})
const csiDriverAddonName = 'aws-ebs-csi-driver'
const ebsCsiAddon = new aws.eks.Addon(csiDriverAddonName, {
  addonName: csiDriverAddonName,
  clusterName: eksCluster.name,
  addonVersion: eksCluster.version.apply(async kubernetesVersion =>
    await aws.eks.getAddonVersion({
      addonName: csiDriverAddonName,
      kubernetesVersion,
      mostRecent: true
    })).version,
  serviceAccountRoleArn: ebsCsiDriverRole.arn,
  resolveConflictsOnCreate: 'OVERWRITE'
})

// === EKS === Addons === Pod Identity Agent ===

const podIdentityAgentAddonName = 'eks-pod-identity-agent'
const podIdentityAgentAddon = new aws.eks.Addon(podIdentityAgentAddonName, {
  addonName: podIdentityAgentAddonName,
  clusterName: eksCluster.name,
  addonVersion: eksCluster.version.apply(async kubernetesVersion =>
    await aws.eks.getAddonVersion({
      addonName: podIdentityAgentAddonName,
      kubernetesVersion,
      mostRecent: true
    })).version,
  resolveConflictsOnCreate: 'OVERWRITE'
})

// === EKS === Cilium ===

const k8sServiceHosts = k8s.core.v1.Endpoints.get('kubernetes-endpoint', 'kubernetes', { provider }).subsets.apply(subsets =>
  subsets.map(subset => subset.addresses.map(address => address.ip)).flat()
)
const cilium = new k8s.helm.v3.Release('cilium', {
  name: 'cilium',
  chart: 'cilium',
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
    envoy: {
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
}, { provider, dependsOn: [awsNodeDaemonSetPatch] })

// === EC2 === Interruption Queue ===

const EC2InterruptionQueueName = `${stackName}-ec2-interruption-queue`
const EC2InterruptionQueue = new aws.sqs.Queue(EC2InterruptionQueueName, {
  messageRetentionSeconds: 300,
  sqsManagedSseEnabled: true,

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

const scheduledChangeRuleName = `${stackName}-scheduled-change-rule`
const scheduledChangeRule = new aws.cloudwatch.EventRule(scheduledChangeRuleName, {
  eventPattern: JSON.stringify({
    source: ['aws.health'],
    'detail-type': ['AWS Health Event']
  }),

})
const scheduledChangeTarget = new aws.cloudwatch.EventTarget(scheduledChangeRuleName, {
  rule: scheduledChangeRule.name,
  arn: EC2InterruptionQueue.arn
})

const spotInterruptionRuleName = `${stackName}-spot-interruption-rule`
const spotInterruptionRule = new aws.cloudwatch.EventRule(spotInterruptionRuleName, {
  eventPattern: JSON.stringify({
    source: ['aws.ec2'],
    'detail-type': ['EC2 Spot Instance Interruption Warning']
  }),

})
const spotInterruptionTarget = new aws.cloudwatch.EventTarget(spotInterruptionRuleName, {
  rule: spotInterruptionRule.name,
  arn: EC2InterruptionQueue.arn
})

const rebalanceRuleName = `${stackName}-rebalance-rule`
const rebalanceRule = new aws.cloudwatch.EventRule(rebalanceRuleName, {
  eventPattern: JSON.stringify({
    source: ['aws.ec2'],
    'detail-type': ['EC2 Instance Rebalance Recommendation']
  }),

})
const rebalanceTarget = new aws.cloudwatch.EventTarget(rebalanceRuleName, {
  rule: rebalanceRule.name,
  arn: EC2InterruptionQueue.arn
})

const instanceStateChangeRuleName = `${stackName}-instance-state-change-rule`
const instanceStateChangeRule = new aws.cloudwatch.EventRule(instanceStateChangeRuleName, {
  eventPattern: JSON.stringify({
    source: ['aws.ec2'],
    'detail-type': ['EC2 Instance State-change Notification']
  }),

})
const instanceStateChangeTarget = new aws.cloudwatch.EventTarget(instanceStateChangeRuleName, {
  rule: instanceStateChangeRule.name,
  arn: EC2InterruptionQueue.arn
})

// === EKS === Karpenter === Controller Role ===

interface KarpenterControllerPolicyProps {
  partitionId: string
  regionId: string
  accountId: string
  eksClusterName: string
  eksNodeRoleName: string
  ec2InterruptionQueueName: string
}

const karpenterControllerPolicy = (
  { partitionId, regionId, accountId, eksClusterName, eksNodeRoleName, ec2InterruptionQueueName }: KarpenterControllerPolicyProps
) => aws.iam.getPolicyDocumentOutput({
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
          variable: `aws:ResourceTag/kubernetes.io/cluster/${eksClusterName}`,
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
          variable: `aws:RequestTag/kubernetes.io/cluster/${eksClusterName}`,
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
          variable: `aws:RequestTag/kubernetes.io/cluster/${eksClusterName}`,
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
          variable: `aws:ResourceTag/kubernetes.io/cluster/${eksClusterName}`,
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
          variable: `aws:ResourceTag/kubernetes.io/cluster/${eksClusterName}`,
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
      resources: [`arn:${partitionId}:sqs:${regionId}:${accountId}:${ec2InterruptionQueueName}`],
      actions: [
        'sqs:DeleteMessage',
        'sqs:GetQueueUrl',
        'sqs:ReceiveMessage'
      ]
    },
    {
      sid: 'AllowPassingInstanceRole',
      effect: 'Allow',
      resources: [`arn:${partitionId}:iam::${accountId}:role/${eksNodeRoleName}`],
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
          variable: `aws:RequestTag/kubernetes.io/cluster/${eksClusterName}`,
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
          variable: `aws:ResourceTag/kubernetes.io/cluster/${eksClusterName}`,
          values: ['owned']
        },
        {
          test: 'StringEquals',
          variable: 'aws:ResourceTag/topology.kubernetes.io/region',
          values: [regionId]
        },
        {
          test: 'StringEquals',
          variable: `aws:RequestTag/kubernetes.io/cluster/${eksClusterName}`,
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
          variable: `aws:ResourceTag/kubernetes.io/cluster/${eksClusterName}`,
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
      resources: [`arn:${partitionId}:eks:${regionId}:${accountId}:cluster/${eksClusterName}`],
      actions: ['eks:DescribeCluster']
    }
  ]
})

const partitionId = await aws.getPartition().then(partition => partition.id)
const regionId = await aws.getRegion().then(region => region.id)
const accountId = await aws.getCallerIdentity().then(identity => identity.accountId)

const karpenterControllerPolicyName = `${stackName}-karpenter-controller-policy`
const KarpenterControllerPolicy = new aws.iam.Policy(karpenterControllerPolicyName, {
  policy: pulumi.all([eksCluster.name, EC2InterruptionQueue.name, eksNodeRole.name]).apply(([eksClusterName, ec2InterruptionQueueName, eksNodeRoleName]) =>
    karpenterControllerPolicy({
      partitionId, regionId, accountId, eksClusterName: eksClusterName, eksNodeRoleName, ec2InterruptionQueueName
    }).json),
})
const karpenterControllerRoleName = `${stackName}-karpenter-controller-role`
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
})
const karpenterControllerRolePolicyAttachment = new aws.iam.RolePolicyAttachment(karpenterControllerRoleName, {
  policyArn: KarpenterControllerPolicy.arn,
  role: karpenterControllerRole
})

const podIdentityAssociation = new aws.eks.PodIdentityAssociation('pod-identity-association', {
  clusterName: eksCluster.name,
  namespace: 'kube-system',
  serviceAccount: 'karpenter',
  roleArn: karpenterControllerRole.arn,
})

// === EKS === Karpenter ===

const karpenter = new k8s.helm.v3.Release('karpenter', {
  name: 'karpenter',
  chart: 'oci://public.ecr.aws/karpenter/karpenter',
  namespace: 'kube-system',
  values: {
    logLevel: 'debug',
    settings: {
      clusterName: eksCluster.name,
      interruptionQueue: EC2InterruptionQueue.name,
      featureGates: {
        spotToSpotConsolidation: true
      }
    }
  }
}, { provider })

// === EKS === Karpenter === Node Class ===

const defaultNodeClassName = `default-node-class`
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
          'karpenter.sh/discovery': eksCluster.name
        }
      }
    ],
    securityGroupSelectorTerms: [
      {
        tags: {
          'karpenter.sh/discovery': eksCluster.name
        }
      }
    ]
  }
}, { provider, dependsOn: [karpenter] })

// === EKS === Karpenter === Node Pool ===

const defaultNodePoolName = `default-node-pool`
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
        ],
        nodeClassRef: {
          apiVersion: 'karpenter.k8s.aws/v1beta1',
          kind: 'EC2NodeClass',
          name: defaultNodeClass.metadata.name
        },
      }
    },
    limits: {
      cpu: 10
    },
    disruption: {
      consolidationPolicy: 'WhenUnderutilized',
      expireAfter: '48h'
    }
  }
}, { provider, dependsOn: [karpenter] })

// === EKS === ArgoCD ===

// const argocd = new k8s.helm.v3.Release('argocd', {
//   name: 'argocd',
//   chart: 'argo-cd',
//   namespace: 'argocd',
//   repositoryOpts: {
//     repo: 'https://argoproj.github.io/argo-helm'
//   },
//   values: {
//     'redis-ha': {
//       enabled: true
//     },
//     controller: {
//       replicas: 1
//     },
//     server: {
//       autoscaling: {
//         enabled: true,
//         minReplicas: 2
//       }
//     },
//     repoServer: {
//       autoscaling: {
//         enabled: true,
//         minReplicas: 2
//       }
//     },
//     applicationSet: {
//       replicas: 2
//     }
//   },
//   createNamespace: true
// }, { provider, customTimeouts: { create: '30m' } })

export const kubeconfig = kubeconfigJson
