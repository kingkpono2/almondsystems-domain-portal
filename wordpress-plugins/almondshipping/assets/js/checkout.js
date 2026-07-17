(function($){
    'use strict';

    function selectedState(){
        var useShipping = $('#ship-to-different-address-checkbox').is(':checked');
        return useShipping ? $('#shipping_state').val() : $('#billing_state').val();
    }

    function toggleArea(){
        var show = selectedState() === 'LA';
        var $field = $('.almondshipping-area-field');
        $field.toggle(show);
        if (!show) {
            $('#billing_almondshipping_delivery_area').val('');
        }
    }

    function updateCheckoutSoon(){
        window.clearTimeout(window.almondshippingCheckoutTimer);
        window.almondshippingCheckoutTimer = window.setTimeout(function(){
            $(document.body).trigger('update_checkout');
        }, 250);
    }

    $(function(){
        toggleArea();
        $(document.body).on('change', '#billing_state,#shipping_state,#ship-to-different-address-checkbox', function(){
            toggleArea();
            updateCheckoutSoon();
        });
        $(document.body).on('input change', '#billing_almondshipping_delivery_area', updateCheckoutSoon);
        $(document.body).on('updated_checkout', toggleArea);
    });
})(jQuery);
