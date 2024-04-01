import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config();
const project = config.require("project");
const env = config.require("env")

const vpcName = `${project}-${env}-vpc`;
const vpc = new aws.ec2.Vpc(vpcName, {
    cidrBlock: "10.0.0.0/16",
    enableDnsSupport: true,
    enableDnsHostnames: true,
    tags: {
        "Name": vpcName,
        "Project": project,
    }
});

const availabilityZones = await aws.getAvailabilityZones({ state: "available" });
const publicSubnets = availabilityZones.names.map((az, index) => {
    const subnetName = `${vpcName}-public-${index}`;
    return new aws.ec2.Subnet(subnetName, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${index}.0/24`,
        availabilityZone: az,
        mapPublicIpOnLaunch: true,
        tags: {
            "Name": subnetName,
            "Project": project,
        }
    });
});
const privateSubnets = availabilityZones.names.map((az, index) => {
    const subnetName = `${vpcName}-private-${index}`;
    return new aws.ec2.Subnet(subnetName, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${index + 10}.0/24`,
        availabilityZone: az,
        mapPublicIpOnLaunch: false,
        tags: {
            "Name": subnetName,
            "Project": project,
        }
    });
});

const internetGatewayName = `${vpcName}-igw`;
const internetGateway = new aws.ec2.InternetGateway(internetGatewayName, {
    vpcId: vpc.id,
    tags: {
        "Name": internetGatewayName,
        "Project": project,
    }
});

const publicRouteTableName = `${vpcName}-public-rt`;
const publicRouteTable = new aws.ec2.RouteTable(publicRouteTableName, {
    vpcId: vpc.id,
    routes: [{
        cidrBlock: "0.0.0.0/0",
        gatewayId: internetGateway.id,
    }],
    tags: {
        "Name": publicRouteTableName,
        "Project": project,
    }
});

const publicSubnetAssociations = publicSubnets.map((subnet, index) => {
    return new aws.ec2.RouteTableAssociation(`${publicRouteTableName}-assoc-${index}`, {
        routeTableId: publicRouteTable.id,
        subnetId: subnet.id,
    });
});

const eipName = `${vpcName}-eip`;
const eip = new aws.ec2.Eip(eipName, {
    domain: "vpc",
    tags: {
        "Name": eipName,
        "Project": project,
    }
});

const natGatewayName = `${vpcName}-nat-gw`;
const natGateway = new aws.ec2.NatGateway(natGatewayName, {
    subnetId: publicSubnets[0].id,
    allocationId: eip.id,
    connectivityType: "public",
    tags: {
        "Name": natGatewayName,
        "Project": project,
    }
});

const privateRouteTableName = `${vpcName}-private-rt`;
const privateRouteTable = new aws.ec2.RouteTable(privateRouteTableName, {
    vpcId: vpc.id,
    routes: [{
        cidrBlock: "0.0.0.0/0",
        natGatewayId: natGateway.id,
    }],
    tags: {
        "Name": privateRouteTableName,
        "Project": project,
    }
});

const privateSubnetAssociations = privateSubnets.map((subnet, index) => {
    return new aws.ec2.RouteTableAssociation(`${privateRouteTableName}-assoc-${index}`, {
        routeTableId: privateRouteTable.id,
        subnetId: subnet.id,
    });
});

const kmsKeyName = `${project}-${env}-kms`;
const kmsKey = new aws.kms.Key(kmsKeyName, {
    description: "KMS key for encrypting resources",
    deletionWindowInDays: 10,
    tags: {
        "Name": kmsKeyName,
        "Project": project,
    }
});

const clusterVersion = "1.29";
const clusterName = `${project}-${env}-eks`;
const cluster = new eks.Cluster(clusterName, {
    name: clusterName,
    version: clusterVersion,
    vpcId: vpc.id,
    createOidcProvider: true,
    publicSubnetIds: publicSubnets.map(s => s.id),
    privateSubnetIds: privateSubnets.map(s => s.id),
    encryptionConfigKeyArn: kmsKey.arn,
    nodeAssociatePublicIpAddress: false,
    defaultAddonsToRemove: ["kube-proxy"],
    nodeGroupOptions: {
        instanceType: "m7g.medium",
        desiredCapacity: 1,
        taints: {
            "node.cilium.io/agent-not-ready": {
                value: "true",
                effect: "NoExecute",
            }
        }
    },
    tags: {
        "Name": clusterName,
        "Project": project,
        "karpenter.sh/discovery": clusterName
    }
});

const k8sProvider = new k8s.Provider(clusterName, {
    kubeconfig: cluster.kubeconfig
});

const awsNodeDaemonSetPatch = new k8s.apps.v1.DaemonSetPatch("aws-node-cilium", {
    metadata: {
        namespace: "kube-system",
        name: "aws-node",
    },
    spec: {
        template: {
            spec: {
                nodeSelector: {
                    "io.cilium/aws-node-enabled": "true",
                },
            },
        },
    },
}, { provider: k8sProvider });

const gatewayAPIController = new k8s.yaml.ConfigFile("gateway-api-controller", {
    file: "https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.0.0/standard-install.yaml"
}, { provider: k8sProvider });

const k8sServiceHosts = k8s.core.v1.Endpoints.get("kubernetes-endpoint", "kubernetes", { provider: k8sProvider }).subsets.apply(subsets =>
    subsets.map(subset => subset.addresses.map(address => address.ip)).flat()
);

const ciliumChartName = "cilium";
const cilium = new k8s.helm.v3.Release(ciliumChartName, {
    chart: ciliumChartName,
    namespace: "kube-system",
    repositoryOpts: {
        repo: "https://helm.cilium.io",
    },
    values: {
        kubeProxyReplacement: "strict",
        k8sServiceHost: k8sServiceHosts[0],
        ingressController: {
            enabled: true,
            loadbalancerMode: "dedicated",
            default: true
        },
        hubble: {
            relay: {
                enabled: true,
            },
            ui: {
                enabled: true,
            },
        },
        loadBalancer: {
            algorithm: "maglev",
            l7: {
                backend: "envoy",
            },
        },
        gatewayAPI: {
            enabled: true,
        },
        operator: {
            replicas: 1,
        },
        routingMode: "native",
        bpf: {
            masquerade: true,
        },
        ipam: {
            mode: "eni",
        },
        eni: {
            enabled: true,
            awsEnablePrefixDelegation: true,
        },
    },
}, { provider: k8sProvider, dependsOn: [gatewayAPIController, awsNodeDaemonSetPatch] });

const coreDNSAddonName = "coredns";
const coreDNSAddon = new aws.eks.Addon(coreDNSAddonName, {
    addonName: coreDNSAddonName,
    clusterName: cluster.eksCluster.name,
    addonVersion: (await aws.eks.getAddonVersion({
        addonName: coreDNSAddonName,
        kubernetesVersion: clusterVersion,
        mostRecent: true,
    })).version,
    resolveConflictsOnCreate: 'OVERWRITE',
}, { dependsOn: [cilium] });

const vpcCniAddonName = "vpc-cni";
const vpcCniAddon = new aws.eks.Addon(vpcCniAddonName, {
    addonName: vpcCniAddonName,
    clusterName: cluster.eksCluster.name,
    addonVersion: (await aws.eks.getAddonVersion({
        addonName: vpcCniAddonName,
        kubernetesVersion: clusterVersion,
        mostRecent: true,
    })).version,
    resolveConflictsOnCreate: 'OVERWRITE',
}, { dependsOn: [cilium] });

const ebsCsiDriverRoleName = `${project}-${env}-ebs-csi-driver-irsa`;
const ebsCsiDriverRole = new aws.iam.Role(ebsCsiDriverRoleName, {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ec2.amazonaws.com",
    }),
    tags: {
        "Name": ebsCsiDriverRoleName,
        "Project": project,
    }
});
const policyAttachment = new aws.iam.RolePolicyAttachment(`${ebsCsiDriverRoleName}-attachment`, {
    role: ebsCsiDriverRole,
    policyArn: "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
});
const csiDriverAddonName = "aws-ebs-csi-driver";
const ebsCsiAddon = new aws.eks.Addon(csiDriverAddonName, {
    addonName: csiDriverAddonName,
    clusterName: cluster.eksCluster.name,
    addonVersion: (await aws.eks.getAddonVersion({
        addonName: csiDriverAddonName,
        kubernetesVersion: clusterVersion,
        mostRecent: true,
    })).version,
    serviceAccountRoleArn: ebsCsiDriverRole.arn,
    resolveConflictsOnCreate: 'OVERWRITE',
}, { dependsOn: [cilium] });

export const kubeconfig = cluster.kubeconfig;