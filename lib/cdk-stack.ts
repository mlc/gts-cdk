import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';

interface Props extends cdk.StackProps {
  domainName: string;
  hostedZone?: string;
  accountDomain?: string;
  certificateArn?: string;
  mailgunSecretName?: string;
}

export class GoToSocialStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    {
      domainName,
      hostedZone,
      accountDomain,
      certificateArn,
      mailgunSecretName,
      ...props
    }: Props
  ) {
    super(scope, id, props);

    const taskRole = new iam.Role(this, 'taskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    const s3User = new iam.User(this, 's3user');
    const s3Key = new iam.AccessKey(this, 's3key', {
      user: s3User,
      status: iam.AccessKeyStatus.ACTIVE,
    });

    const dataBucket = new s3.Bucket(this, 'dataBucket', {
      blockPublicAccess: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    dataBucket.grantReadWrite(taskRole);

    const vpc = new ec2.Vpc(this, 'gtsVpc', {
      maxAzs: 3,
      natGateways: 1,
      subnetConfiguration: [
        {
          subnetType: ec2.SubnetType.PUBLIC,
          name: 'public',
        },
        {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          name: 'private',
        },
        {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          name: 'private egress',
        },
      ],
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'dbSecurity', {
      vpc,
      allowAllOutbound: false,
    });
    const db = new rds.DatabaseInstance(this, 'db', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_14,
      }),
      autoMinorVersionUpgrade: true,
      backupRetention: cdk.Duration.days(7),
      databaseName: 'gotosocial',
      storageEncrypted: true,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO
      ),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [dbSecurityGroup],
    });

    const environment: Record<string, string> = {
      GTS_HOST: domainName,
      GTS_ACCOUNT_DOMAIN: accountDomain ?? '',
      GTS_PROTOCOL: 'https',
      GTS_TRUSTED_PROXIES: vpc.vpcCidrBlock,
      GTS_PORT: '8080',
      GTS_DB_TYPE: 'postgres',
      GTS_DB_ADDRESS: db.instanceEndpoint.hostname,
      GTS_DB_PORT: db.instanceEndpoint.port.toString(),
      GTS_DB_TLS_MODE: 'enable',
      GTS_STORAGE_BACKEND: 's3',
      GTS_STORAGE_S3_BUCKET: dataBucket.bucketName,
      GTS_STORAGE_S3_ACCESS_KEY: s3Key.accessKeyId,
      GTS_STORAGE_S3_SECRET_KEY: s3Key.secretAccessKey.unsafeUnwrap(),
      GTS_STORAGE_S3_ENDPOINT: `s3.${this.region}.amazonaws.com`,
      GTS_LETSENCRYPT_ENABLED: 'false',
      GTS_LETSENCRYPT_EMAIL_ADDRESS: '',
    };

    const dbUser = ecs.Secret.fromSecretsManager(db.secret!, 'username');
    const dbPassword = ecs.Secret.fromSecretsManager(db.secret!, 'password');

    const secrets: Record<string, ecs.Secret> = {
      GTS_DB_USER: dbUser,
      GTS_DB_PASSWORD: dbPassword,
    };

    if (mailgunSecretName) {
      const mailgunSecret = secretsmanager.Secret.fromSecretNameV2(
        this,
        'mailgunSecret',
        mailgunSecretName
      );
      secrets.GTS_SMTP_USERNAME = ecs.Secret.fromSecretsManager(
        mailgunSecret,
        'username'
      );
      secrets.GTS_SMTP_FROM = ecs.Secret.fromSecretsManager(
        mailgunSecret,
        'username'
      );
      secrets.GTS_SMTP_PASSWORD = ecs.Secret.fromSecretsManager(
        mailgunSecret,
        'password'
      );
      environment.GTS_SMTP_HOST = 'smtp.mailgun.org';
      environment.GTS_SMTP_PORT = '587';
    }

    const cluster = new ecs.Cluster(this, 'cluster', { vpc });
    const domainZone = route53.HostedZone.fromLookup(this, 'domainZone', {
      domainName: hostedZone ?? domainName,
    });

    const taskSecurityGroup = new ec2.SecurityGroup(this, 'taskSecurity', {
      vpc,
      allowAllOutbound: true,
    });
    dbSecurityGroup.addIngressRule(taskSecurityGroup, ec2.Port.tcp(5432));

    const certificate: acm.ICertificate | undefined = certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'cert', certificateArn)
      : undefined;

    const service = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this,
      'service',
      {
        cluster,
        taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        cpu: 512,
        desiredCount: 1,
        memoryLimitMiB: 2048,
        publicLoadBalancer: true,
        targetProtocol: ApplicationProtocol.HTTP,
        protocol: ApplicationProtocol.HTTPS,
        redirectHTTP: true,
        domainName,
        domainZone,
        certificate,
        openListener: true,
        securityGroups: [taskSecurityGroup],
        taskImageOptions: {
          image: ecs.ContainerImage.fromRegistry(
            'superseriousbusiness/gotosocial:latest'
          ),
          containerName: 'gotosocial',
          containerPort: 8080,
          environment,
          secrets,
          taskRole,
        },
      }
    );

    service.node.addDependency(db);
  }
}
