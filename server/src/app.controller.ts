import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello() {
    return this.appService.getHello();
  }

  @Get("start")
  start(){
    // TODO: start all services 
  }


  @Get("stop")
  stop(){
    // TODO: stop all services
  }

  @Get("killswitch")
  killswitch(){
    // TODO: implement killswitch functionality
  }

}
