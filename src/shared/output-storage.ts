export interface OutputStorageUsage {
  outputDirectory: string
  bytes: number
  fileCount: number
  exists: boolean
  unreadableCount: number
  
  truncated?: boolean
}
