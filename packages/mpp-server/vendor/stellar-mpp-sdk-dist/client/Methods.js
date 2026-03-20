import { charge as charge_ } from './Charge.js';
export function stellar(parameters) {
    return charge_(parameters);
}
(function (stellar) {
    stellar.charge = charge_;
})(stellar || (stellar = {}));
//# sourceMappingURL=Methods.js.map