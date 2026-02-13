import { Injectable } from '@nestjs/common';
import { Logger } from '@nestjs/common';

@Injectable()
export class DetectionClusterService {
    private logger: Logger = new Logger(DetectionClusterService.name);
    private readonly cluster_id:number

    constructor(
        cluster_id: number
    ) {
        this.cluster_id = cluster_id;
    }

    async startDetection(wallets: string[]) {
        
    }

    

}
