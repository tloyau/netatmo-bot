var Flint = require('node-flint');
var webhook = require('node-flint/webhook');
var express = require('express');
var bodyParser = require('body-parser');
var https = require("https");
var request = require('request');
var sync_request = require('sync-request');
var fs = require('fs');
const querystring = require('querystring');

var app = express();
app.use(bodyParser.json());

var configFlint = '';
var configMyBot = '';
var optionsAuth = '';
var paramsAuth = '';
var optionsWeather = '';

var flint = '';
var server = '';

var currentFile = '';

// Bot stats
var numberOfMessages = 0;
var today = '';

// Netatmo Authentication
var access_token = '';
var refresh_token = '';
var scope = '';

var roomAlreadyDeleted = false;
var roomAlreadyCreated = false;
var isFlintInitialized = false;

// initialize the configFlint and configMyBot
fs.readFile('./config/config.json', 'utf8', function(err, data) {
    if (err) {
        return console.log(err);
    }
    data = JSON.parse(data);

    configMyBot = data.mybot;
    configFlint = data.flint;
    optionsAuth = data.optionsAuth;
    paramsAuth = querystring.stringify(data.paramsAuth);
    optionsWeather = data.optionsWeather;

    initializeFlint();
});

function initializeFlint() {
    // initialization of Flint with config.json
    flint = new Flint(configFlint);
    flint.start();

    flint.messageFormat = 'markdown';

    // show battery percentage of Netatmo module in Van Gogh
    flint.hears('battery', function(bot, trigger) {
        try {
            authentication(function() {
                getStationsData(function() {
                    var lvlBatteryVanGogh = stationsData.devices[0].modules[0].battery_percent;
                    bot.say('**Van Gogh Module Extérieur, niveau de batterie:** %s%', lvlBatteryVanGogh);
                });
            });
        } catch (err) {
            writeLogs(err);
        }
    });

    // show status of Kandinsky and Van Gogh: temperature, humidity, CO2, Noise
    flint.hears('status', function(bot, trigger) {
        try {
            authentication(function() {
                getStationsData(function() {
                    var infosKandinsky = stationsData.devices[0].dashboard_data;
                    var infosVanGogh = stationsData.devices[0].modules[0].dashboard_data;

                    bot.say('**Kandinsky:**\n- Température : %s°C\n- Humidité : %s%\n- Taux de CO2 : %sppm\n- Nuisance sonore : %sdB\n\n**Van Gogh :**\n- Température : %s°C\n- Humidité : %s%',
                        infosKandinsky.Temperature,
                        infosKandinsky.Humidity,
                        infosKandinsky.CO2,
                        infosKandinsky.Noise,
                        infosVanGogh.Temperature,
                        infosVanGogh.Humidity);
                });
            });
        } catch (err) {
            writeLogs(err);
        }
    });

    // say hello
    flint.hears('bonjour', function(bot, trigger) {
        bot.say('Bonjour %s !', trigger.personDisplayName);
    });

    // show how to interact with the demo-bot
    flint.hears('help', function(bot, trigger) {
        bot.say("Je suis le Netatmo-Bot, je sais répondre à trois commandes:" +
            "\n\n- **@netatmo status**: Ce sont les informations du Showroom (Kandinsky & Van Gogh)" + "\n\n- **@netatmo battery**: C\'est le niveau de batterie du module Netatmo installé dans la salle Van Gogh" + "\n\n - **@netatmo stats**: Ce sont des informations sur moi");
    });

    flint.hears('stats', function(bot, trigger) {
        var strMessage = '';
        var strRoom = '';

        if (flint.bots.length > 1) {
            strRoom = ' rooms.';
        } else {
            strRoom = ' room.';
        }

        if (numberOfMessages > 1) {
            strMessage = ' messages.';
        } else {
            strMessage = ' message.';
        }

        bot.say('Je suis présent dans ' + flint.bots.length + strRoom + '\n\nAujourd\'hui, on m\'a envoyé ' + numberOfMessages + strMessage);
    });

    flint.hears(/.*/, function(bot, trigger) {
        bot.say("Je vous prie de m'excuser mais je ne comprends pas ce que vous dites.\n\nUtilisez la commande **_help_** afin de connaître les commandes auxquelles je peux répondre." +
            "\n\nPS: n'oubliez pas de me mentionner si vous êtes dans une room avec plusieurs personnes, comme ceci :\n- @netatmo-bot help");
    }, 20);

    flint.on('message', function(bot, trigger, id) {
        writeLogs('"' + trigger.personEmail + '" said "' + trigger.text + '" in room "' + trigger.roomTitle + '"');

        var date = new Date();
        date = date.getDate();

        if (trigger.personEmail != configMyBot.mail_bot) {
            if (date != today) {
                numberOfMessages = 1;
                today = date;
            } else {
                numberOfMessages += 1;
            }
        }
    });

    flint.on('initialized', function() {
        isFlintInitialized = true;
        writeLogs('initialized ' + flint.bots.length + ' rooms');
        //setTimeout(cleanBotRooms, 1000);
    });

    app.post('/flint', webhook(flint));

    server = app.listen(configFlint.port, function() {
        writeLogs('Flint listening on port ' + configFlint.port);
    });

    setInterval(function() {
        run_script();
    }, configMyBot.time_interval_check_co2);
}

function writeLogs(textLog) {
    var date = new Date();
    dateFinal = date.getDate() + '-' + date.getMonth() + '-' + date.getFullYear();

    var hours = date.getHours() + '-' + date.getMinutes() + '-' + date.getSeconds();

    var tmp_path = configMyBot.filepath_log + dateFinal + '.txt';

    if (currentFile == '') {
        currentFile = tmp_path;
    } else if (currentFile != tmp_path) {
        currentFile = tmp_path;
    }

    textLog = hours + ' - ' + textLog + '\n';

    fs.appendFileSync(currentFile, textLog);
}

// function for authenticate from Netatmo API
// this function is called each time flint hears "battery" or "status"
function authentication(callbackFunction) {
    var callbackAuth = function(response) {
        response.on('error', function(e) {
            writeLogs('error : ' + e);
        });
        var res = '';

        response.on('data', function(chunk) {
            res += chunk;
        });

        response.on('end', function() {
            try {
                res = JSON.parse(res);
                if (response.statusCode == '200') {
                    access_token = res.access_token;
                    refresh_token = res.refresh_token;
                    scope = res.scope;
                    writeLogs("Your access_token is: " + access_token);
                    writeLogs("Your refresh_token is: " + refresh_token);
                    writeLogs("Your scopes are: " + scope);

                    callbackFunction();
                } else {
                    writeLogs('status code:', response.statusCode, '\n', res);
                }
            } catch (err) {
                writeLogs(err);
            }
        });
    };

    var reqAuth = https.request(optionsAuth, callbackAuth);

    reqAuth.on('error', function(e) {
        writeLogs('There is a problem with your request:', e.message);
    });

    reqAuth.write(paramsAuth);
    reqAuth.end();
}

// Netatmo Weather Station – Getstationsdata
var stationsData = '';

// function for recover the data sent by Netatmo
function getStationsData(callbackFunction) {
    var paramsWeather = querystring.stringify({
        'access_token': access_token
    });

    var callbackWeather = function(response) {
        response.on('error', function(e) {
            writeLogs('error', e);
        });
        var res = '';

        response.on('data', function(chunk) {
            res += chunk;
        });

        response.on('end', function() {
            try {
                res = JSON.parse(res);
                if (response.statusCode == '200') {
                    stationsData = res.body;

                    callbackFunction();
                } else {
                    writeLogs('status code:', response.statusCode, '\n', res);
                }
            } catch (err) {
                writeLogs(err);
            }
        });
    };

    var reqWeather = https.request(optionsWeather, callbackWeather);
    reqWeather.on('error', function(e) {
        writeLogs('There is a problem with your request:', e.message);
    });

    reqWeather.write(paramsWeather);
    reqWeather.end();
}

function cleanBotRooms() {
    flint.spark.roomsGet(100)
        .then(function(rooms) {
            var length = Object.keys(rooms).length;

            var room = '';
            var room_id = '';

            for (var i = 0; i < length; ++i) {
                room = rooms[i];

                if (room.title == configMyBot.room_name) {
                    room_id = room.id;
                    writeLogs('room -> ' + room.title);

                    deleteRoom(room_id);
                }
            }

            writeLogs('finish');
        })
        .catch(function(err) {
            // process error
            writeLogs('error get rooms : ' + err);
        });
}

function run_script() {
    if (isFlintInitialized) {
        try {
            authentication(function() {
                getStationsData(function() {
                    var infosKandinsky = stationsData.devices[0].dashboard_data;

                    if (infosKandinsky.CO2 > configMyBot.seuil_co2) {
                        writeLogs('CO2 -> ' + infosKandinsky['CO2']);
                        if (!roomAlreadyCreated) {
                            roomAlreadyCreated = true;
                            alertPeople(infosKandinsky);
                        }
                    } else {
                        if (roomAlreadyCreated) {
                            deleteRoomCO2();
                        }
                        writeLogs('CO2 -> ' + infosKandinsky['CO2']);
                    }
                });
            });
        } catch (err) {
            writeLogs(err);
        }
    }
}

function deleteRoomCO2() {
    flint.spark.roomsGet(10)
        .then(function(rooms) {
            var length = Object.keys(rooms).length;

            var room = '';
            var room_id = '';

            for (var i = 0; i < length; ++i) {
                room = rooms[i];

                if (room.title == configMyBot.room_name) {
                    room_id = room.id;
                    writeLogs('room -> ' + room.title);
                    break;
                }
            }

            if (room_id != '') {
                deleteRoom(room_id);
            }
        })
        .catch(function(err) {
            // process error
            writeLogs('error get rooms : ' + err);
        });
}

function run_script_btnPressed() {
    if (!roomAlreadyCreated && isFlintInitialized) {
        try {
            authentication(function() {
                getStationsData(function() {
                    roomAlreadyCreated = true;
                    var infosKandinsky = stationsData.devices[0].dashboard_data;
                    writeLogs('CO2 -> ' + infosKandinsky['CO2']);
                    alertPeople(infosKandinsky);
                });
            });
        } catch (err) {
            writeLogs(err);
        }
    }
}

function alertPeople(infosKandinsky) {
    flint.spark.roomAdd(configMyBot.room_name)
        .then(function(room) {
            writeLogs('room -> ' + room.title + ' created !');

            addUsersShowroom(room.id, infosKandinsky);
        })
        .catch(function(err) {
            // process error
            writeLogs(err);
        });
}

function addUsersShowroom(room_id, infosKandinsky) {
    for (var i = 0; i < configMyBot.usersShowRoom.length; ++i) {
        flint.spark.membershipAdd(room_id, configMyBot.usersShowRoom[i])
            .then(function(membership) {
                writeLogs('membership ok !');
            })
            .catch(function(err) {
                writeLogs(err);
            });
    }

    flint.spark.messageSendRoom(room_id, {
            markdown: '**Le taux de CO2 relevé dans la salle Kandinsky est anormal. Veuillez prendre les mesures nécessaires:**\n- Taux de CO2 : ' +
                infosKandinsky.CO2
        })
        .then(function(message) {
            writeLogs('Message sent: ' + message.text);
        })
        .catch(function(err) {
            writeLogs(err);
        });

    flint.spark.messageSendRoom(room_id, {
            files: configMyBot.url_image
        })
        .then(function(message) {
            flint.spark.messageSendRoom(room_id, {
                    markdown: "Je suis le Netatmo-Bot, je sais répondre à trois commandes:" +
                        "\n\n- **@netatmo status**: Ce sont les informations du Showroom (Kandinsky & Van Gogh)" + "\n\n- **@netatmo battery**: C\'est le niveau de batterie du module Netatmo installé dans la salle Van Gogh" + "\n\n - **@netatmo stats**: Ce sont des informations sur moi"
                })
                .then(function(message) {
                    writeLogs('Message sent: ' + message.text);
                })
                .catch(function(err) {
                    writeLogs(err);
                });
        })
        .catch(function(err) {
            writeLogs(err);
        });
}

app.get('/', function(req, res) {
    var functionAPI = req.query.function;

    flint.spark.roomsGet(10)
        .then(function(rooms) {
            var length = Object.keys(rooms).length;

            var room = '';
            var room_id = '';

            for (var i = 0; i < length; ++i) {
                room = rooms[i];

                if (room.title == configMyBot.room_name) {
                    room_id = room.id;
                    writeLogs('room -> ' + room.title);
                    break;
                }
            }

            if (room_id != '') {
                callWithButton(room_id, functionAPI);
                res.sendStatus(200);
            } else {
                writeLogs('Room not created, we run the script !');
                run_script_btnPressed();
                res.sendStatus(200);
            }
        })
        .catch(function(err) {
            // process error
            writeLogs('error get rooms : ' + err);
        });
});

function callWithButton(room_id, functionAPI) {
    if (functionAPI == 'call' || functionAPI == 'callend') {
        var url = configMyBot.api_url + room_id + '?showSipAddress=true';
        request({
            url: url,
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'Authorization': 'Bearer ' + configFlint.token
            }
        }, function(error, response, body) {
            if (response.statusCode == 200) {
                body = JSON.parse(body);
                var sipuri = body.sipAddress;
                for (var i = 0; i < configMyBot.endpoints.length; i++) {
                    sendRequest(functionAPI, sipuri, configMyBot.endpoints[i], room_id);
                }
                if (functionAPI == 'callend') {
                    deleteRoom(room_id);
                }
            } else {
                writeLogs(error);
                writeLogs(response.statusCode);
            }
        });
    }
}

function sendRequest(functionAPI, sipuri, endpoint, room_id) {
    var url = configMyBot.php_api_url;

    writeLogs('url: ' + url);
    writeLogs('functionAPI: ' + functionAPI);
    writeLogs('sipuri: ' + sipuri);
    writeLogs('endpoint: ' + endpoint);
    writeLogs('room_id: ' + room_id);

    request.post({
        url: url,
        headers: {
            'content-type': 'application/json; charset=utf-8'
        },
        form: {
            functionAPI: functionAPI,
            sipuri: sipuri,
            endpoint: endpoint
        }
    }, function(error, response, body) {
        if (response.statusCode == 200) {
            writeLogs(body);
        } else {
            writeLogs(error);
            writeLogs(body);
            writeLogs(response.statusCode);
        }
    });
}

function deleteRoom(room_id) {
    flint.spark.roomRemove(room_id)
        .then(function() {
            roomAlreadyCreated = false;
            writeLogs('Room removed.');
        })
        .catch(function(err) {
            // process error
            writeLogs(err);
        });
}

// gracefully shutdown (ctrl-c)
process.on('SIGINT', function() {
    writeLogs('stoppping...');
    server.close();
    flint.stop().then(function() {
        process.exit();
    });
});
