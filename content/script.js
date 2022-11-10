$(function () {
    // Makes sure the quantity can never be less than one
    $('input[name="Quantity"]').on("change", function () {
        if ($(this).val() < 1) $(this).val(1);
    });

    // Makes sure the price can never be less than zero
    $('input[name="Price"]').on("keyup change", function () {
        if ($(this).val() < 0) $(this).val(0);
    });

    // Saves new-item input value on local storage on change
    $('.new-item').on("keyup change", function () {
        let name = $(this).attr("name");
        localStorage.setItem(`new-item-${name}`, $(this).val());
    });

    // Load input values if there are any saved
    $('.new-item').each(function (i, element) {
        let name = $(this).attr("name");
        let item_value = localStorage.getItem(`new-item-${name}`);

        if (item_value !== null) $(element).val(item_value);
    });
});

function newItem() {
    let data = {};
    let valid = true;

    $('.new-item').each(function (i, element) {
        if ($(element).val() === '') {
            $(element).focus();
            valid = false;
        }

        data[$(element).attr("name")] = $(element).val();
    });

    if (valid == false) return 0;

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

                let index = 1;

                $('input[name="Index"]').each(function (i, element) {
                    index = $(element).val() > index ? $(element).val() : index;
                });

                let htmlTR = `<tr>
                                <td class="d-flex">
                                    <input type="hidden" name="Index" value="${index}">
                                    <input class="form-control item w-100 input-with-btn" type="text"
                                        placeholder="Item" name="Name" value="${obj.supermarket_item.Name}"
                                        onchange="changeItem(this)">
                                    <button class="btn btn-danger input-btn" type="button"
                                        onclick="removeItem(this)">
                                        <i class="fas fa-trash-alt"></i>
                                    </button>
                                </td>
                                <td>
                                    <input class="form-control item text-end" type="number" placeholder="Quantity"
                                        name="Quantity" value="${obj.supermarket_item.Quantity}" onchange="changeItem(this)">
                                </td>
                                <td>
                                    <input class="form-control item text-end" type="number" placeholder="Price"
                                        name="Price" value="${obj.supermarket_item.Price}" onchange="changeItem(this)">
                                </td>
                                <td class="text-center align-middle total-item-price">
                                    ${obj.supermarket_item.TotalFormat}
                                </td>
                            </tr>`;

                
                $('.new-items').before($(htmlTR));

                $('.new-item').val(null);
                $('input[name="Quantity"].new-item').val(1);

                // Makes sure the quantity can never be less than one
                $('input[name="Quantity"]').on("change", function () {
                    if ($(this).val() < 1) $(this).val(1);
                });

                // Makes sure the price can never be less than zero
                $('input[name="Price"]').on("keyup change", function () {
                    if ($(this).val() < 0) $(this).val(0);
                });


                $('.total-price').text(`Total: ${obj.total_formatted}`);
            }
        },
        error: function (obj) {
            console.log(obj);
        }
    });
}

function changeItem(element) {
    let parent = $(element).parents('tr');

    let data = {};
    let valid = true;

    data["Index"] = $(parent).find('>:first-child>input[name="Index"]').val();

    $(parent).find('.item').each(function (i, element) {
        let element_name = $(element).attr("name");

        if ($(element).val() === '') {
            $(element).focus();
            valid = false;
        }
        
        if ($(element).val() < 1 && element_name === "Quantity") $(element).val(1);

        if ($(element).val() < 0 && element_name === "Price") $(element).val(0);

        data[element_name] = $(element).val();
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

                $(parent).find('.total-item-price').text(obj.supermarket_item.TotalFormat);
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

    data["Index"] = $(element).siblings('input[name="Index"]').val();

    $.ajax({
        url: "/RemoveItem",
        type: "Post",
        async: true,
        data: data,
        dataType: "json",
        success: function (obj) {
            window.location.reload();
        },
        error: function (obj) {
            console.log(obj);
        }
    });

}

// just so I can have my supermarket list synced between multiple devices (Super important!!)
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