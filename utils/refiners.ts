import { z } from 'zod'

export const s3BucketName = (bucketName: string) =>
  z
    .string()
    .min(3)
    .max(63)
    // start and end with a letter or number
    .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
    // not start with the prefix xn-- or sthree- or sthree-configurator
    // not end with the suffix -s3alias or --ol-s3
    .regex(/^(?!xn--|sthree-|sthree-configurator|.*--ol-s3|.*-s3alias)/)
    // not contain two adjacent periods
    .regex(/^(?!.*\.\.)/)
    // not formatted as an IP address
    .regex(/^(?!.*\d+\.\d+\.\d+\.\d+)/)
    .parse(bucketName)
