import { Injectable, Logger } from "@nestjs/common";
import WebSocket from "ws";


@Injectable()
export class WalletWebSocketService {
    private readonly logger: Logger = new Logger(WalletWebSocketService.name);
    private readonly ws: WebSocket;
    private readonly ws_url:string = 'wss://api.hyperliquid.xyz/ws'

    constructor(
        private readonly cluster_id: number,
        private readonly wallet: string
    ){
        this.ws = new WebSocket(this.ws_url);
    }
}





