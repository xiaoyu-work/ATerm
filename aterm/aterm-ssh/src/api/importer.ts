import { PartialProfile } from 'aterm-core'
import { SSHProfile } from './interfaces'

export abstract class SSHProfileImporter {
    abstract getProfiles (): Promise<PartialProfile<SSHProfile>[]>
}

export abstract class AutoPrivateKeyLocator {
    abstract getKeys (): Promise<[string, Buffer][]>
}
