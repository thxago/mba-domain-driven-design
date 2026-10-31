import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { OrderService } from '../../@core/events/application/order.service';
import { CancelOrderService } from '../../@core/events/application/cancel-order.service';

@Controller('events/:event_id/orders')
export class OrdersController {
  constructor(
    private ordersService: OrderService,
    private cancelOrderService: CancelOrderService,
  ) {}

  @Post(':order_id/cancel')
  cancel(@Param('order_id') order_id: string) {
    return this.cancelOrderService.cancel(order_id);
  }

  @Get()
  async list() {
    return this.ordersService.list();
  }

  @Post()
  create(
    @Param('event_id') event_id: string,
    @Body()
    body: {
      section_id: string;
      spot_id: string;
      customer_id: string;
      card_token: string;
    },
  ) {
    return this.ordersService.create({
      ...body,
      event_id: event_id,
    });
  }
}
