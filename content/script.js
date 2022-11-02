$(function () {
    $('input[name="Quantity"]').on("keyup change", function () {
        if ($(this).val() < 1) $(this).val(1);
    });
});

function newItem() {
    let data = {};
    let valid = true;

    $('.new-item').each(function (i, e) {
        if ($(e).val() === '') {
            $(e).focus();
            valid = false;
        }

        data[$(e).attr("name")] = $(e).val();
    });

    if (valid == false) return 0;

    $.ajax({
        url: "/NewItem",
        type: "Post",
        async: true,
        data: data,
        dataType: "json",
        success: function () { window.location.reload() },
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

    $(parent).find('.item').each(function (i, e) {
        if ($(e).val() === '') {
            $(e).focus();
            valid = false;
        }

        data[$(e).attr("name")] = $(e).val();
    });

    if (valid == false) return 0;

    $.ajax({
        url: "/ChangeItem",
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
function checkForUpdate(version) {
    $.ajax({
        url: "/GetVersion",
        type: "Get",
        data: {version},
        async: true,
        success: function (obj) {
            if (obj.version != version) window.location.reload();
        }
    });
}