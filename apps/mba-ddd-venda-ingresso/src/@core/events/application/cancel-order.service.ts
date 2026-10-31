import { ApplicationService } from '../../common/application/application.service';
import { IOrderRepository } from '../domain/repositories/order-repository.interface';

export class CancelOrderService {
  constructor(
    private orderRepo: IOrderRepository,
    private applicationService: ApplicationService,
  ) {}

  cancel(order_id: string) {
    return this.applicationService.run(async () => {
      const order = await this.orderRepo.findById(order_id);
      if (!order) {
        throw new Error('Order not found');
      }

      order.cancel();
      await this.orderRepo.add(order);
      return order;
    });
  }
}