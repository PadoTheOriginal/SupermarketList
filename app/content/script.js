$(function () {
    init_input_rules();
    
    // Saves new-item input value on local storage on change
    $('.new-item').on("keyup change", function () {
        let supermarket_list_id = $(this).parents('.card').children('.supermarket-list-info').val();

        let name = $(this).attr("name");
        localStorage.setItem(`${supermarket_list_id}-new-item-${name}`, $(this).val());
    });

    // Load input values if there are any saved
    $('.new-item').each(function (i, element) {
        let supermarket_list_id = $(this).parents('.card').children('.supermarket-list-info').val();

        let name = $(this).attr("name");
        let item_value = localStorage.getItem(`${supermarket_list_id}-new-item-${name}`);

        if (item_value !== null) $(element).val(item_value);
    });
});

function init_input_rules() {
    $('.new-item').val(null);
    $('input[name="Quantity"][value=""]').val(1);

    // Makes sure the quantity can never be less than one
    $('input[name="Quantity"]').on("change", function () {
        if ($(this).val() < 1) $(this).val(1);
    });

    // Makes sure the price can never be less than zero
    $('input[name="Price"]').on("keyup change", function () {
        if ($(this).val() < 0) $(this).val(0);
    });
}

// Lists
function newList() {
    let data = {};
    let valid = true;

    let $supermarketList = $(element).parents('.card');

    data["SupermarketListId"] = $supermarketList.find('.supermarket-list-info').val();

    let $new_items = $($supermarketList.find('.new-items'));

    let $new_item_btn = $(element);

    $new_items.find('.new-item').each(function (i, element) {
        if ($(element).val() === '') {
            $(element).focus();
            valid = false;
        }

        data[$(element).attr("name")] = $(element).val();
    });

    if (valid == false) return 0;

    $new_item_btn.prop('disabled', true);

    $.ajax({
        url: "/NewList",
        type: "Post",
        async: true,
        data: data,
        dataType: "json",
        success: function (obj) {
            if (obj.success === true) {
                supermarket_list_version = obj.version;
                localStorage.clear();

                let htmlTR = `<tr class="item-tr">
                                <td>
                                    <div class="d-flex position-relative">
                                        <input class="item" type="hidden" name="SupermarketItemId" value="${obj.supermarket_item.SupermarketItemId}">
                                        <input class="item" type="hidden" name="SupermarketListId" value="${obj.supermarket_item.SupermarketListId}">
                                        <input class="form-control item w-100 input-with-btn" type="text"
                                        placeholder="Item" name="Name" value="${obj.supermarket_item.Name}"
                                        onchange="changeItem(this)">
                                        <button class="btn btn-danger input-btn" type="button"
                                        onclick="removeItem(this)">
                                            <i class="fas fa-trash-alt"></i>
                                        </button>
                                    </div>
                                </td>
                                <td class="px-0">
                                    <input class="form-control item text-end" type="number" placeholder="Quantity"
                                        name="Quantity" value="${obj.supermarket_item.Quantity}" onchange="changeItem(this)">
                                </td>
                                <td>
                                    <input class="form-control item text-end" type="number" placeholder="Price"
                                        name="Price" value="${obj.supermarket_item.Price}" onchange="changeItem(this)">
                                </td>
                                <td class="text-center align-middle total-item-price ps-0">
                                    ${obj.supermarket_item.TotalFormatted}
                                </td>
                            </tr>`;


                $new_items.before($(htmlTR));

                init_input_rules();

                $supermarketList.find('.total-price').text(`Total: ${obj.total_formatted}`);
                $new_item_btn.prop('disabled', false);
            }
        },
        error: function (obj) {
            alert('Error');
        }
    });
}

// Items
function newItem(element) {
    let data = {};
    let valid = true;

    let $supermarketList = $(element).parents('.card');

    data["SupermarketListId"] = $supermarketList.find('.supermarket-list-info').val();

    let $new_items = $($supermarketList.find('.new-items'));

    let $new_item_btn = $(element);

    $new_items.find('.new-item').each(function (i, element) {
        if ($(element).val() === '') {
            $(element).focus();
            valid = false;
        }

        data[$(element).attr("name")] = $(element).val();
    });

    if (valid == false) return 0;

    $new_item_btn.prop('disabled', true);

    $.ajax({
        url: "/NewItem",
        type: "Post",
        async: true,
        data: data,
        dataType: "json",
        success: function (obj) {
            if (obj.success === true) {
                supermarket_list_version = obj.version;
                localStorage.clear();

                let htmlTR = `<tr class="item-tr">
                                <td>
                                    <div class="d-flex position-relative">
                                        <input class="item" type="hidden" name="SupermarketItemId" value="${obj.supermarket_item.SupermarketItemId}">
                                        <input class="item" type="hidden" name="SupermarketListId" value="${obj.supermarket_item.SupermarketListId}">
                                        <input class="form-control item w-100 input-with-btn" type="text"
                                        placeholder="Item" name="Name" value="${obj.supermarket_item.Name}"
                                        onchange="changeItem(this)">
                                        <button class="btn btn-danger input-btn" type="button"
                                        onclick="removeItem(this)">
                                            <i class="fas fa-trash-alt"></i>
                                        </button>
                                    </div>
                                </td>
                                <td class="px-0">
                                    <input class="form-control item text-end" type="number" placeholder="Quantity"
                                        name="Quantity" value="${obj.supermarket_item.Quantity}" onchange="changeItem(this)">
                                </td>
                                <td>
                                    <input class="form-control item text-end" type="number" placeholder="Price"
                                        name="Price" value="${obj.supermarket_item.Price}" onchange="changeItem(this)">
                                </td>
                                <td class="text-center align-middle total-item-price ps-0">
                                    ${obj.supermarket_item.TotalFormatted}
                                </td>
                            </tr>`;


                $new_items.before($(htmlTR));

                init_input_rules();

                $supermarketList.find('.total-price').text(`Total: ${obj.total_formatted}`);
                $new_item_btn.prop('disabled', false);
            }
        },
        error: function (obj) {
            alert('Error');
        }
    });
}

function changeItem(element) {
    let data = {};
    let valid = true;
    let parent = $(element).parents('tr');

    $(parent).find('.item').each(function (i, element) {
        if ($(element).val() === '') {
            $(element).focus();
            valid = false;
        }

        if ($(element).val() < 1 && $(element).attr("name") === "Quantity") $(element).val(1);

        if ($(element).val() < 0 && $(element).attr("name") === "Price") $(element).val(0);

        data[$(element).attr("name")] = $(element).val();
    });

    if (valid == false) return 0;

    $.ajax({
        url: "/ChangeItem",
        type: "Post",
        async: true,
        data: data,
        dataType: "json",
        success: function (obj) {
            if (obj.success === true) {
                supermarket_list_version = obj.version;

                $(parent).find('.total-item-price').text(obj.supermarket_item.TotalFormatted);
                $('.total-price').text(`Total: ${obj.total_formatted}`);
            }
        },
        error: function (obj) {
            alert('Error');
        }
    });

}

function removeItem(element) {
    let data = {};
    let parent = $(element).parents('tr');

    data["SupermarketListId"] = $(element).siblings('input[name="SupermarketListId"]').val();
    data["SupermarketItemId"] = $(element).siblings('input[name="SupermarketItemId"]').val();

    $(element).prop('disabled', true);

    $.ajax({
        url: "/RemoveItem",
        type: "Post",
        async: true,
        data: data,
        dataType: "json",
        success: function (obj) {
            if (obj.success === true) {
                supermarket_list_version = obj.version;

                $(parent).remove();

                $('.total-price').text(`Total: ${obj.total_formatted}`);
            }
        },
        error: function (obj) {
            alert('Error');
        }
    });

}

// just so I can have my supermarket list synced between multiple devices (Super important!! or stupid)
function checkForUpdate() {
    $.ajax({
        url: "/GetVersion",
        type: "Get",
        data: { supermarket_list_version },
        async: true,
        success: function (obj) {
            if (obj.version != supermarket_list_version) window.location.reload();
        }
    });
}